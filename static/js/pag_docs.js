/* Área: Vencimento de documentos (alvará da arena, auditoria interna e outros).
   Cadastro dos documentos, datas de renovação e vencimento, alertas e histórico de anexos. */
"use strict";

App.docs = { dados: null };
const DOC_SIT = {
  VENCIDO: ["Vencido", "etiqueta--alerta"], VENCENDO: ["Vencendo", "etiqueta--venc"],
  "EM DIA": ["Em dia", "etiqueta--ok"], "SEM DATA": ["Sem renovação", ""], "EM PROCESSO": ["Em processo", "etiqueta--rateio"],
};
/** situação só pela data (sem a marca de em processo) */
const situacaoPelaData = (d) => {
  if (!d.data_vencimento) return "SEM DATA";
  const dias = Math.round((new Date(d.data_vencimento + "T12:00:00") - new Date(App.hoje() + "T12:00:00")) / 864e5);
  return dias < 0 ? "VENCIDO" : dias <= (d.aviso_dias ?? 60) ? "VENCENDO" : "EM DIA";
};
const docPer = (m) => { const p = (App.docs.dados.periodicidades || []).find(([v]) => v === (m || 0)); return p ? p[1] : `${m} meses`; };
const docEtiqueta = (d) => d.arquivado ? el("span", { class: "etiqueta" }, "Arquivado") : el("span", { class: "etiqueta " + DOC_SIT[d.situacao][1] }, DOC_SIT[d.situacao][0]);
const docPrazo = (d) => d.dias_para_vencer === null || d.dias_para_vencer === undefined ? "" :
  d.dias_para_vencer < 0 ? `venceu há ${-d.dias_para_vencer} dia(s)` : d.dias_para_vencer === 0 ? "vence hoje" : `vence em ${d.dias_para_vencer} dia(s)`;

App.docs.carregar = async function () {
  const d = await App.api("/api/docs");
  App.docs.dados = d;
  const n = d.alertas.vencidos.length + d.alertas.vencendo.length;
  ["badge-docs", "badge-docs-area"].forEach((id) => {
    const b = document.getElementById(id);
    if (b) { b.hidden = !n; b.textContent = n; b.title = `${d.alertas.vencidos.length} vencido(s) · ${d.alertas.vencendo.length} vencendo`; }
  });
  return d;
};

App.paginas.docs = async function (raiz, params) {
  const sub = params[0] === "vencimentos" ? "vencimentos" : "lista";
  try { await App.docs.carregar(); } catch (e) { raiz.append(el("div", { class: "cartao vazio" }, e.message)); return; }
  raiz.append(el("div", { class: "pagina-cabecalho" },
    el("div", {}, el("h2", {}, sub === "lista" ? "Todos os documentos" : "Próximos vencimentos"),
      el("p", {}, sub === "lista" ? "Alvará da arena, auditoria interna e outros: renovação, vencimento e histórico de anexos"
        : "O que vence nos próximos meses, para começar as renovações a tempo")),
    el("div", { class: "acoes" }, ...App.importacao.botoes(), el("button", { class: "btn", onclick: () => docEditar({}) }, "+ Novo documento"))));
  const corpo = el("div");
  raiz.append(corpo);
  (sub === "lista" ? docLista : docVencimentos)(corpo);
};

function docFaixaAlertas(irPara) {
  const A = App.docs.dados.alertas;
  if (!A.vencidos.length && !A.vencendo.length) return null;
  return el("div", { class: "alertas-nf" },
    A.vencidos.length ? el("a", { class: "alerta-nf alerta-nf--saldo", onclick: () => irPara("VENCIDO") }, el("i", { class: "alerta-ponto" }), el("span", {}, el("b", {}, `${A.vencidos.length} documento(s)`), " vencido(s)")) : null,
    A.vencendo.length ? el("a", { class: "alerta-nf alerta-nf--venc", onclick: () => irPara("VENCENDO") }, el("i", { class: "alerta-ponto alerta-ponto--aviso" }), el("span", {}, el("b", {}, `${A.vencendo.length} documento(s)`), " vencendo (dentro do prazo de aviso)")) : null);
}

/* ------------------------------------------------------------------ LISTA */
function docLista(corpo) {
  const D = App.docs.dados;
  const est = { cat: "", sit: "", q: "" };
  try { Object.assign(est, JSON.parse(sessionStorage.getItem("docs_filtro") || "{}")); } catch (e) { /* ok */ }
  const salvar = () => { try { sessionStorage.setItem("docs_filtro", JSON.stringify(est)); } catch (e) { /* ok */ } };
  const ativos = D.documentos.filter((d) => !d.arquivado);
  const conta = (s) => ativos.filter((d) => d.situacao === s).length;
  const cats = [["", "Todas"], ...D.categorias.map((c) => [c, c.charAt(0) + c.slice(1).toLowerCase()])];
  const sits = [["", "Ativos"], ["VENCIDO", `Vencidos (${conta("VENCIDO")})`], ["VENCENDO", `Vencendo (${conta("VENCENDO")})`], ["EM PROCESSO", `Em processo (${conta("EM PROCESSO")})`],
    ["EM DIA", "Em dia"], ["SEM DATA", "Sem renovação"], ["ARQUIVADO", "Arquivados"]];
  const grupoChips = (lista, chave) => {
    const bs = lista.map(([v, r]) => {
      const b = el("button", { class: "chip", "aria-pressed": String(est[chave] === v) }, r);
      b.onclick = () => { est[chave] = v; salvar(); bs.forEach((x) => x.setAttribute("aria-pressed", String(x === b))); desenhar(); };
      return b;
    });
    return bs;
  };
  const chipsCat = grupoChips(cats, "cat"), chipsSit = grupoChips(sits, "sit");
  const busca = el("input", { type: "search", placeholder: "Documento, nº, órgão ou responsável…", value: est.q });
  let tb; busca.oninput = () => { clearTimeout(tb); tb = setTimeout(() => { est.q = busca.value; salvar(); desenhar(); }, 150); };
  corpo.append(
    docFaixaAlertas((s) => { est.sit = s; salvar(); App.rotear(); }) || "",
    App.barraPadrao({ campos: [
      el("div", { class: "campo" }, el("span", {}, "Categoria"), el("div", { class: "chips" }, chipsCat)),
      el("div", { class: "campo" }, el("span", {}, "Situação"), el("div", { class: "chips" }, chipsSit))],
    busca, limpar: () => { Object.assign(est, { cat: "", sit: "", q: "" }); salvar(); App.rotear(); } }),
    el("div", { class: "kpis" },
      App.kpi("Documentos ativos", App.fmt.num(ativos.length), "core", `${D.documentos.length - ativos.length} arquivado(s)`),
      App.kpi("Vencidos", App.fmt.num(conta("VENCIDO")), conta("VENCIDO") ? "p900" : "branco", "renovar com urgência"),
      App.kpi("Vencendo", App.fmt.num(conta("VENCENDO")), conta("VENCENDO") ? "p100" : "branco", "dentro do prazo de aviso"),
      App.kpi("Em processo", App.fmt.num(conta("EM PROCESSO")), "p100", "renovação em andamento"),
      App.kpi("Em dia", App.fmt.num(conta("EM DIA")), "g200", `${conta("SEM DATA")} sem renovação registrada`)));
  const alvo = el("div");
  corpo.append(alvo);
  function desenhar() {
    App.limpar(alvo);
    const q = App.norm(est.q);
    const lista = D.documentos.filter((d) =>
      (est.sit === "ARQUIVADO" ? d.arquivado : !d.arquivado && (!est.sit || d.situacao === est.sit)) &&
      (!est.cat || d.categoria === est.cat) &&
      (!q || App.norm(`${d.nome} ${d.numero} ${d.orgao} ${d.responsavel} ${d.categoria} ${d.observacao}`).includes(q)));
    alvo.append(App.cartao("Documentos", `${lista.length} documento(s) · clique para ver as renovações`,
      App.tabela([
        { rotulo: "Documento", valor: (d) => d.nome, render: (d) => el("div", { class: "celula-2l" }, el("b", {}, d.nome),
          el("small", {}, [d.numero && `nº ${d.numero}`, d.orgao].filter(Boolean).join(" · ") || "—")) },
        { rotulo: "Categoria", valor: (d) => d.categoria, render: (d) => d.categoria ? el("span", { class: "etiqueta" }, d.categoria) : "—" },
        { rotulo: "Responsável", valor: (d) => d.responsavel, render: (d) => d.responsavel || "—" },
        { rotulo: "Periodicidade", valor: (d) => d.periodicidade_meses || 999, render: (d) => docPer(d.periodicidade_meses) },
        { rotulo: "Última renovação", valor: (d) => d.data_renovacao, render: (d) => App.fmt.data(d.data_renovacao) || "—" },
        { rotulo: "Próximo vencimento", valor: (d) => d.data_vencimento || "9999", render: (d) => el("div", { class: "celula-2l" },
          el("span", {}, App.fmt.data(d.data_vencimento) || "—"),
          d.arquivado ? null : el("small", { style: { color: d.situacao === "VENCIDO" ? "var(--perigo)" : d.situacao === "VENCENDO" ? "#B54708" : "" } }, docPrazo(d))) },
        { rotulo: "Situação", valor: (d) => ({ VENCIDO: 0, VENCENDO: 1, "EM PROCESSO": 2, "EM DIA": 3, "SEM DATA": 4 })[d.situacao], render: docEtiqueta },
        { rotulo: "Renovações", num: true, valor: (d) => d.n_renovacoes, render: (d) => el("div", { class: "celula-2l", style: { textAlign: "right" } },
          el("span", {}, `${d.n_renovacoes}`),
          d.ultimo_anexo ? el("small", {}, el("a", { href: `/api/docs/anexos/${d.ultimo_anexo.id}`, target: "_blank", title: d.ultimo_anexo.nome_original }, "arquivo mais recente")) : null) },
        { rotulo: "", render: (d) => el("div", { class: "acoes-linha" },
          el("button", { class: "btn btn--mini btn--sec", title: "Abrir a lista de renovações e acrescentar a nova", onclick: () => docHistorico(d, true) }, "Renovar"),
          el("button", { class: "btn btn--mini btn--linha", onclick: () => docEditar(d) }, "Editar")) },
      ], lista, { onClick: (d) => docHistorico(d), ordem: { i: 5, dir: 1 }, vazio: "Nenhum documento neste filtro. Cadastre em “+ Novo documento”." })));
  }
  desenhar();
}

/* ------------------------------------------------------------------ PRÓXIMOS VENCIMENTOS */
function docVencimentos(corpo) {
  const D = App.docs.dados;
  const ativos = D.documentos.filter((d) => !d.arquivado && d.data_vencimento);
  const vencidos = ativos.filter((d) => d.situacao === "VENCIDO");
  const futuros = ativos.filter((d) => d.situacao !== "VENCIDO").sort((a, b) => a.data_vencimento.localeCompare(b.data_vencimento));
  const porMes = App.agrupar(futuros, (d) => d.data_vencimento.slice(0, 7));
  const nomeMes = (k) => { const [a, m] = k.split("-"); return ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"][+m - 1] + " de " + a; };
  const item = (d) => el("div", { class: "venc-item", onclick: () => docHistorico(d) },
    el("div", { class: "venc-data" }, el("b", {}, d.data_vencimento.slice(8, 10)), el("small", {}, ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"][+d.data_vencimento.slice(5, 7) - 1])),
    el("div", { class: "celula-2l", style: { flex: 1 } }, el("b", {}, d.nome), el("small", {}, [d.categoria, d.responsavel, docPrazo(d)].filter(Boolean).join(" · "))),
    docEtiqueta(d),
    el("button", { class: "btn btn--mini btn--sec", onclick: (ev) => { ev.stopPropagation(); docHistorico(d, true); } }, "Renovar"));
  corpo.append(
    vencidos.length ? App.cartao("Vencidos", `${vencidos.length} documento(s) — renovar com urgência`, el("div", { class: "venc-lista" }, vencidos.map(item))) : "",
    el("div", { style: { height: vencidos.length ? "16px" : 0 } }),
    Object.keys(porMes).length ? el("div", { class: "grade", style: { gap: "16px" } },
      Object.entries(porMes).map(([k, l]) => App.cartao(nomeMes(k), `${l.length} documento(s)`, el("div", { class: "venc-lista" }, l.map(item)))))
      : el("div", { class: "cartao vazio" }, "Nenhum vencimento futuro cadastrado."));
}

/* ------------------------------------------------------------------ CADASTRO / EDIÇÃO (só os dados principais) */
function docEditar(d) {
  const D = App.docs.dados;
  const novo = !d.id;
  const inp = (tipo, v, extra = {}) => el("input", { type: tipo, value: v ?? "", ...extra });
  const nome = inp("text", d.nome, { placeholder: "ex.: AVCB, Laudo de SPDA, Licença sanitária…" });
  const lista = el("datalist", { id: "doc-categorias" }, D.categorias.map((c) => el("option", { value: c })));
  const cat = inp("text", d.categoria || "", { list: "doc-categorias", placeholder: "ex.: DOCUMENTOS LEGAIS" });
  const resp = inp("text", d.responsavel, { placeholder: "empresa ou órgão que emite / renova" });
  const per = el("select", {}, (D.periodicidades || []).map(([v, r]) => el("option", { value: v, selected: v === (d.periodicidade_meses ?? 12) }, r)));
  if (novo) per.value = "12";
  // Em dia / Vencendo / Vencido: sempre automático (última renovação + periodicidade). Só "em processo" é marcado à mão.
  const proc = el("input", { type: "checkbox", checked: !!d.em_processo, style: { width: "auto", margin: 0 } });
  const autoTxt = novo ? "calculada depois da 1ª renovação"
    : (d.data_vencimento ? `${DOC_SIT[situacaoPelaData(d)][0]} (vence ${App.fmt.data(d.data_vencimento)})` : "sem renovação registrada");
  const sit = el("div", { class: "doc-sit" },
    el("div", {}, el("span", { class: "ajuda" }, "Pela data: "), el("b", {}, autoTxt)),
    el("label", { style: { display: "flex", gap: "8px", alignItems: "center", marginTop: "6px" } }, proc, "Em processo de renovação"),
    el("small", { class: "ajuda" }, "Em dia / Vencido muda sozinho todo dia. Marque “em processo” só enquanto a renovação anda; ao registrar em Renovar, a marca sai sozinha."));
  const obs = el("textarea", { rows: 3 }, d.observacao || "");
  const msg = el("p", { class: "ajuda", style: { color: "var(--perigo)", minHeight: "18px" } });
  App.modal(el("div", { class: "modal--largo" }, el("h3", {}, novo ? "Novo documento" : `Editar · ${d.nome}`), lista,
    el("div", { class: "grade-form" },
      el("label", { class: "campo", style: { gridColumn: "span 2" } }, el("span", {}, "Documento"), nome),
      el("label", { class: "campo" }, el("span", {}, "Categoria"), cat),
      el("label", { class: "campo" }, el("span", {}, "Responsável"), resp),
      el("label", { class: "campo" }, el("span", {}, "Periodicidade"), per),
      el("div", { class: "campo" }, el("span", {}, "Situação"), sit),
      el("label", { class: "campo campo--largo" }, el("span", {}, "Observação"), obs)),
    novo ? el("p", { class: "ajuda" }, "Depois de salvar, registre a última renovação em “Renovar”: o vencimento é calculado pela periodicidade.") : null,
    msg,
    el("div", { class: "linha-acoes" },
      el("button", { class: "btn", onclick: async () => {
        const fd = new FormData();
        Object.entries({ id: d.id || "", nome: nome.value, categoria: cat.value, responsavel: resp.value, periodicidade_meses: per.value,
          situacao: proc.checked ? "EM PROCESSO" : "AUTO", observacao: obs.value }).forEach(([k, v]) => fd.append(k, v));
        try {
          const r = await fetch("/api/docs", { method: "POST", body: fd });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.erro || `Erro ${r.status}`);
          App.fecharModal(); App.toast("Documento salvo.");
          if (novo) { await App.docs.carregar(); const atual = App.docs.dados.documentos.find((x) => x.id === j.id); if (atual) return docHistorico(atual, true); }
          App.rotear();
        } catch (e) { msg.textContent = e.message; }
      } }, "Salvar"),
      el("button", { class: "btn btn--linha", "data-fechar": "" }, "Cancelar"),
      novo ? null : el("button", { class: "btn btn--linha", style: { marginLeft: "auto" }, onclick: async () => {
        const fd = new FormData(); fd.append("id", d.id); fd.append("nome", d.nome); fd.append("categoria", d.categoria || ""); fd.append("responsavel", d.responsavel || "");
        fd.append("observacao", d.observacao || ""); fd.append("arquivado", d.arquivado ? "0" : "1");
        await fetch("/api/docs", { method: "POST", body: fd }); App.fecharModal(); App.toast(d.arquivado ? "Documento reativado." : "Documento arquivado: saiu dos alertas."); App.rotear();
      } }, d.arquivado ? "Reativar" : "Arquivar"),
      novo ? null : el("button", { class: "btn btn--perigo", onclick: async () => {
        if (!(await App.confirmar("Excluir documento", `Excluir “${d.nome}”, todas as renovações e arquivos? Se só não precisa mais renovar, prefira “Arquivar”.`, "Excluir"))) return;
        await App.api(`/api/docs/${d.id}`, { method: "DELETE" }); App.toast("Documento excluído."); App.rotear();
      } }, "Excluir"))));
}

/* ------------------------------------------------------------------ RENOVAÇÕES (uma linha por renovação) */
async function docHistorico(d, abrirNova = false) {
  const linhas = await App.api(`/api/docs/${d.id}/anexos`);
  const renov = linhas.filter((a) => a.data_renovacao).sort((a, b) => b.data_renovacao.localeCompare(a.data_renovacao) || b.id - a.id);
  const soArq = linhas.filter((a) => !a.data_renovacao);
  const somar = (iso, meses) => {
    if (!iso || !meses) return "";
    const [a, m, dia] = iso.split("-").map(Number);
    const t = m - 1 + Number(meses), ano = a + Math.floor(t / 12), mes = t % 12;
    const ult = new Date(ano, mes + 1, 0).getDate();
    return `${ano}-${String(mes + 1).padStart(2, "0")}-${String(Math.min(dia, ult)).padStart(2, "0")}`;
  };
  const reabrir = async () => { await App.docs.carregar(); const atual = App.docs.dados.documentos.find((x) => x.id === d.id); if (atual) docHistorico(atual); else App.fecharModal(); };

  /* linha nova */
  const data = el("input", { type: "date", value: App.hoje(), "aria-label": "Data da renovação" });
  const venc = el("input", { type: "date", "aria-label": "Vencimento" });
  let vencManual = false;
  const sugerir = () => { if (!vencManual) venc.value = somar(data.value, d.periodicidade_meses); };
  data.oninput = sugerir; venc.oninput = () => (vencManual = !!venc.value); sugerir();
  const arq = el("input", { type: "file", "aria-label": "Arquivo (opcional)" });
  const obs = el("input", { type: "text", placeholder: "ex.: protocolo nº…", "aria-label": "Observação" });
  const msg = el("p", { class: "ajuda", style: { color: "var(--perigo)", minHeight: "18px", margin: 0 } });
  const btnAdd = el("button", { class: "btn", onclick: async () => {
    if (!data.value) { msg.textContent = "Informe a data da renovação."; return; }
    const fd = new FormData();
    fd.append("data_renovacao", data.value); fd.append("data_vencimento", venc.value); fd.append("observacao", obs.value);
    if (arq.files[0]) fd.append("arquivo", arq.files[0]);
    btnAdd.disabled = true;
    try {
      const r = await fetch(`/api/docs/${d.id}/renovacoes`, { method: "POST", body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.erro || `Erro ${r.status}`);
      App.toast(`Renovação registrada${j.vencimento ? ` · próximo vencimento ${App.fmt.data(j.vencimento)}` : ""}.`);
      await reabrir();
    } catch (e) { msg.textContent = e.message; btnAdd.disabled = false; }
  } }, "+ Adicionar renovação");
  const nova = el("div", { class: "doc-nova" },
    el("label", { class: "campo" }, el("span", {}, "Data da renovação"), data),
    el("label", { class: "campo" }, el("span", {}, d.periodicidade_meses ? `Vence em (${docPer(d.periodicidade_meses).toLowerCase()})` : "Vence em"), venc),
    el("label", { class: "campo" }, el("span", {}, "Arquivo (opcional)"), arq),
    el("label", { class: "campo" }, el("span", {}, "Observação"), obs),
    btnAdd);

  const excluir = (a) => el("button", { class: "btn btn--mini btn--linha", title: "Excluir esta linha", onclick: async () => {
    if (!(await App.confirmar("Excluir renovação", `Excluir a linha de ${App.fmt.data(a.data_renovacao) || a.nome_original}?`, "Excluir"))) return;
    await App.api(`/api/docs/anexos/${a.id}`, { method: "DELETE" }); App.toast("Linha excluída."); await reabrir();
  } }, "✕");
  App.modal(el("div", { class: "modal--largo" },
    el("h3", {}, d.nome),
    el("div", { class: "resumo-contrato", style: { marginTop: 0 } },
      docEtiqueta(d),
      el("span", {}, "Periodicidade: ", el("b", {}, docPer(d.periodicidade_meses))),
      el("span", {}, "Última renovação: ", el("b", {}, App.fmt.data(d.data_renovacao) || "—")),
      el("span", {}, "Próximo vencimento: ", el("b", {}, App.fmt.data(d.data_vencimento) || "—"), d.arquivado || !d.data_vencimento ? "" : ` (${docPrazo(d)})`),
      d.responsavel ? el("span", {}, "Responsável: ", el("b", {}, d.responsavel)) : null),
    d.observacao ? el("p", { class: "ajuda" }, d.observacao) : null,
    el("h4", { style: { margin: "14px 0 6px" } }, "Renovar"),
    el("p", { class: "ajuda", style: { marginTop: 0 } }, "Cada linha é uma renovação. A data da linha mais recente vira a última renovação, e o próximo vencimento é essa data + a periodicidade."),
    App.meta.editavel ? nova : null, App.meta.editavel ? msg : null,
    App.tabela([
      { rotulo: "Renovado em", valor: (a) => a.data_renovacao, render: (a) => el("b", {}, App.fmt.data(a.data_renovacao)) },
      { rotulo: "Vence em", valor: (a) => a.data_vencimento, render: (a) => App.fmt.data(a.data_vencimento) || "—" },
      { rotulo: "Arquivo", valor: (a) => a.nome_original, render: (a) => a.arquivo ? el("a", { href: `/api/docs/anexos/${a.id}`, target: "_blank" }, a.nome_original) : el("span", { class: "ajuda" }, "—") },
      { rotulo: "Observação", valor: (a) => a.observacao, render: (a) => el("div", { class: "celula-2l" }, el("span", {}, a.observacao || "—"),
        el("small", {}, `registrado por ${a.enviado_por || "—"} em ${App.fmt.dataCurta(a.enviado_em.slice(0, 10))}`)) },
      { rotulo: "", render: (a) => App.meta.editavel ? excluir(a) : "" },
    ], renov, { vazio: "Nenhuma renovação registrada ainda. Adicione a primeira acima.", escolherColunas: false }),
    soArq.length ? el("div", {}, el("h4", { style: { margin: "14px 0 6px" } }, `Outros arquivos (${soArq.length})`),
      App.tabela([
        { rotulo: "Arquivo", render: (a) => el("a", { href: `/api/docs/anexos/${a.id}`, target: "_blank" }, a.nome_original) },
        { rotulo: "Observação", render: (a) => a.observacao || "—" },
        { rotulo: "", render: (a) => App.meta.editavel ? excluir(a) : "" }], soArq, { escolherColunas: false })) : null,
    el("div", { class: "linha-acoes" },
      el("button", { class: "btn btn--linha", onclick: () => docEditar(d) }, "Editar dados"),
      el("button", { class: "btn btn--linha", "data-fechar": "", onclick: () => App.rotear() }, "Fechar"))));
  if (abrirNova && App.meta.editavel) setTimeout(() => data.focus(), 60);
}
