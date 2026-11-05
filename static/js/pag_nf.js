/* Área: Notas fiscais (Medições, Contratos, Gráficos, Prazos e feriados, Configurações).
   Só aparece para quem tem a guia "Notas fiscais" liberada na tela Equipe.
   As medições vêm do servidor já filtradas e paginadas (o site continua rápido com muitos dados). */
"use strict";

App.nf = { base: null };
const NF_CORES = { prazo: "#4F8F33", atraso: "#6A0BB0", com: "#A876F0", sem: "#B42318" };
const NF_STATUS = { PROSSEGUIU: "Prosseguiu", PENDENTE: "Pendente", CANCELADA: "Cancelada" };
const NF_SUBS = {
  medicoes: ["Medições", "Medições das notas fiscais, e-mails para o fiscal e solicitação de NFs aos fornecedores"],
  contratos: ["Contratos", "Saldo atual = (saldo contratado + aditivo) − medições"],
  graficos: ["Gráficos", "Quantidade e valor medidos, SLA e prazos dos fornecedores"],
  prazos: ["Prazos e feriados", "Data limite das NFs de cada mês e feriados (não contam como dia útil)"],
  config: ["Configurações", "Alertas, prazos e destinatários dos e-mails"],
};

App.paginas.nf = async function (raiz, params) {
  if (params[0] === "pedidos") {   // pedidos de compra (tela e dados no módulo do budget; usa o mesmo filtro das outras guias)
    try { await App.bud.carregarBase(); } catch (e) { raiz.append(el("div", { class: "cartao vazio" }, e.message)); return; }
    await budPedidos(raiz);
    return;
  }
  const sub = NF_SUBS[params[0]] ? params[0] : "medicoes";
  try { if (!App.bud.base) await App.bud.carregarBase(); } catch (e) { /* sem cadastros do budget: filtros de CC/projeto ficam vazios */ }
  try { await App.nf.carregarBase(); } catch (e) { raiz.append(el("div", { class: "cartao vazio" }, e.message)); return; }
  raiz.append(el("div", { class: "pagina-cabecalho" }, el("div", {}, el("h2", {}, NF_SUBS[sub][0]), el("p", {}, NF_SUBS[sub][1]))));
  if (sub === "prazos") App.acoesCabecalho(App.importacao.botoes());
  const corpo = el("div");
  raiz.append(corpo);
  await ({ medicoes: nfMedicoes, contratos: nfContratos, graficos: nfGraficos, prazos: nfPrazos, config: nfConfig })[sub](corpo);
};

App.nf.carregarBase = async function () {
  App.nf.base = await App.api("/api/nf/base");
  const n = new Set([...App.nf.base.alertas.saldo, ...App.nf.base.alertas.vencimento]).size;
  const b = document.getElementById("badge-contratos");
  if (b) { b.hidden = !n; b.textContent = n; b.title = `${n} contrato(s) com alerta`; }
  return App.nf.base;
};

/* ------------------------------------------------------------------ filtro comum das guias de Notas fiscais
   Período (de / até), atalhos de período, centro de custo e projeto. É o mesmo em Medições, Contratos, Pedidos de compra,
   Gráficos e Prazos: o que for escolhido numa guia continua valendo ao trocar de guia. */
App.nf.fc = (() => { try { return { de: "", ate: "", cc: "", projeto: "", base: "", ...JSON.parse(sessionStorage.getItem("nf_fc") || "{}") }; } catch (e) { return { de: "", ate: "", cc: "", projeto: "", base: "" }; } })();
/** Qual data da NF vale para o período: medição (padrão, a mesma do budget), emissão ou vencimento. */
App.nf.BASES = [["", "Data da medição"], ["emissao", "Data de emissão da NF"], ["vencimento", "Data de vencimento"]];
App.nf.dataRef = (dMed, dEmi, dVen) => ({ emissao: dEmi || dMed, vencimento: dVen || dEmi }[App.nf.fc.base] || dMed || dEmi || "");
App.nf.noPeriodo = (d) => !!d && (!App.nf.fc.de || d >= App.nf.fc.de) && (!App.nf.fc.ate || d <= App.nf.fc.ate);
App.nf.temPeriodo = () => !!(App.nf.fc.de || App.nf.fc.ate);
App.nf.salvarFc = () => { try { sessionStorage.setItem("nf_fc", JSON.stringify(App.nf.fc)); } catch (e) { /* ok */ } };
App.nf.fcParams = () => Object.fromEntries(Object.entries(App.nf.fc).filter(([, v]) => v));
/** Campos do filtro comum. aoMudar() é chamado a cada mudança. semClasse: esconde centro de custo e projeto (ex.: feriados). */
App.nf.camposFiltro = function (aoMudar, { rotuloData = "Período", semClasse = false, comBase = false } = {}) {
  const f = App.nf.fc;
  const de = el("input", { type: "date", value: f.de, "aria-label": rotuloData + ": de" }), ate = el("input", { type: "date", value: f.ate, "aria-label": rotuloData + ": até" });
  // data local (toISOString usa UTC e à noite já virava o dia seguinte)
  const hoje = new Date(), iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`, ano = hoje.getFullYear();
  const menos = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };
  const mes0 = (k) => new Date(hoje.getFullYear(), hoje.getMonth() + k, 1);
  const presets = [
    ["Este mês", iso(mes0(0)), iso(new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0))],
    ["Mês passado", iso(mes0(-1)), iso(new Date(hoje.getFullYear(), hoje.getMonth(), 0))],
    ["90 dias", menos(90), iso(hoje)],
    [String(ano), `${ano}-01-01`, `${ano}-12-31`], [String(ano - 1), `${ano - 1}-01-01`, `${ano - 1}-12-31`], ["Tudo", "", ""]];
  const chips = presets.map(([r, a, b]) => {
    const c = el("button", { class: "chip chip--mini", "aria-pressed": String(f.de === a && f.ate === b) }, r);
    c.onclick = () => { f.de = de.value = a; f.ate = ate.value = b; marcar(); App.nf.salvarFc(); aoMudar(); };
    return c;
  });
  const marcar = () => chips.forEach((c, i) => c.setAttribute("aria-pressed", String(f.de === presets[i][1] && f.ate === presets[i][2])));
  de.onchange = () => { f.de = de.value; marcar(); App.nf.salvarFc(); aoMudar(); };
  ate.onchange = () => { f.ate = ate.value; marcar(); App.nf.salvarFc(); aoMudar(); };
  const campos = [App.campo(rotuloData, el("div", { class: "presets" }, de, ate)),
    el("div", { class: "campo" }, el("span", {}, "Atalhos"), el("div", { class: "presets" }, chips))];
  if (comBase) {
    const selBase = el("select", {}, App.nf.BASES.map(([v, r]) => el("option", { value: v, selected: (f.base || "") === v }, r)));
    selBase.onchange = () => { f.base = selBase.value; App.nf.salvarFc(); aoMudar(); };
    campos.push(App.campo("Período pela", selBase));   // ajuste fino: fica em "Mais filtros"
  }
  if (!semClasse) {
    const C = (App.bud.base && App.bud.base.cadastros) || { centros: [], projetos: [] };
    const selCc = el("select", {}, el("option", { value: "" }, "Todos"), C.centros.map((c) => el("option", { value: c.nome, selected: c.nome === f.cc }, App.bud.rotCc(c.nome))));
    const selPj = el("select");
    const opcoesPj = () => {
      App.limpar(selPj).append(el("option", { value: "" }, "Todos"),
        ...C.projetos.filter((p) => !selCc.value || !p.centro_custo || p.centro_custo === selCc.value)
          .map((p) => el("option", { value: p.nome, selected: p.nome === f.projeto }, App.bud.rotPj(p.nome))));
      if (![...selPj.options].some((o) => o.value === f.projeto)) f.projeto = "";
    };
    opcoesPj();
    selCc.onchange = () => { f.cc = selCc.value; opcoesPj(); App.nf.salvarFc(); aoMudar(); };
    selPj.onchange = () => { f.projeto = selPj.value; App.nf.salvarFc(); aoMudar(); };
    campos.push(App.campo("Centro de custo", selCc), App.campo("Projeto", selPj));
  }
  return campos;
};
App.nf.limparFc = () => { Object.assign(App.nf.fc, { de: "", ate: "", cc: "", projeto: "", base: "" }); App.nf.salvarFc(); };

/* ------------------------------------------------------------------ utilidades */
App.nf.cfg = (k) => +String(App.nf.base.config[k] || 0).replace(",", ".");
App.nf.diasUteis = function (ini, fim) {
  if (!ini || !fim) return null;
  const fer = new Set((App.nf.base.feriados || []).map((f) => f.data));
  let a = new Date(ini + "T12:00:00"), b = new Date(fim + "T12:00:00"), sinal = 1;
  if (b < a) { [a, b] = [b, a]; sinal = -1; }
  let n = 0;
  for (let d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) {
    if (d.getDay() % 6 !== 0 && !fer.has(App.iso(d))) n++;
  }
  return n ? sinal * (n - 1) : 0;
};

/** Janela do e-mail: baixa o .eml já com destinatários, texto e anexo, que abre no novo Outlook para conferir e enviar.
    Abrir sem o arquivo (link do Outlook, aplicativo padrão) fica em "Outros jeitos": esses caminhos não aceitam anexo.
    Resolve true ao fechar; false se pediu para parar (e-mails em lote). */
App.nf.baixarEmail = async function (url, { lote = "" } = {}) {
  const base = `${url}?hora=${new Date().getHours()}`;
  const r = await fetch(`${base}&modo=dados`);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { App.toast(d.erro || `Erro ${r.status}`, true); return false; }
  const q = (o) => Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const virgula = (t) => (t || "").split(/[;,]/).map((x) => x.trim()).filter(Boolean).join(",");
  const campos = { to: virgula(d.para), cc: virgula(d.cc), bcc: virgula(d.cco), subject: d.assunto };
  const textoCabe = encodeURIComponent(d.texto).length < 5500;   // endereço muito longo é cortado pelo navegador
  const web = `https://outlook.office.com/mail/deeplink/compose?${q({ ...campos, body: textoCabe ? d.texto : "" })}`;
  const mailto = `mailto:${campos.to}?${q({ cc: campos.cc, bcc: campos.bcc, subject: campos.subject, body: textoCabe ? d.texto : "" })}`;
  const copiar = (t, aviso) => async () => { try { await navigator.clipboard.writeText(t); App.toast(aviso); } catch (e) { App.toast("Não consegui copiar.", true); } };
  const semArquivo = () => {
    fetch(`${base}&modo=marcar`).catch(() => {});
    if (d.anexo_url) { const a = el("a", { href: d.anexo_url, download: "" }); document.body.append(a); a.click(); a.remove(); }
  };
  const linha = (rot, v) => (v ? [el("dt", {}, rot), el("dd", {}, v)] : []);
  return new Promise((res) => {
    let parar = false;
    const m = document.getElementById("modal");
    App.modal(el("div", { class: "modal--largo" }, el("h3", {}, lote ? `E-mail ${lote}` : "Enviar e-mail"),
      el("dl", { class: "perfil-dados" }, linha("Para", d.para || "nenhum: preencha no Outlook"), linha("Cc", d.cc), linha("Cco", d.cco), linha("Assunto", d.assunto)),
      el("ol", { class: "email-passos" },
        el("li", {}, el("b", {}, "Baixe o e-mail. "), d.com_anexo ? "Ele já vem preenchido e com a NF anexada." : "Ele já vem preenchido."),
        el("li", {}, el("b", {}, "Abra o arquivo no novo Outlook. "), "Se abrir o Outlook antigo: botão direito no arquivo › Abrir com › Outlook (new)."),
        el("li", {}, el("b", {}, "Confira e envie. "), "Se a assinatura não aparecer, use Inserir › Assinatura."),
        d.com_anexo === false && url.includes("/medicoes/") ? el("li", { class: "email-aviso" }, "O arquivo da NF não foi encontrado: anexe manualmente.") : null),
      el("div", { class: "linha-acoes" },
        el("a", { class: "btn", href: base }, d.com_anexo ? "Baixar e-mail com a NF" : "Baixar e-mail"),
        lote ? el("button", { class: "btn btn--linha", type: "button", onclick: () => { parar = true; App.fecharModal(); } }, "Parar aqui") : null,
        el("button", { class: "btn btn--linha", type: "button", "data-fechar": "" }, lote ? "Próximo" : "Fechar")),
      el("details", { class: "email-outros" }, el("summary", {}, "Outros jeitos de enviar"),
        d.anexo_url ? el("p", { class: "ajuda" }, "Sem anexo automático: a NF é baixada para você anexar à mão.") : null,
        el("div", { class: "linha-acoes" },
          el("a", { class: "btn btn--linha", href: web, target: "_blank", rel: "noopener", onclick: semArquivo }, "Abrir no Outlook pela web"),
          el("a", { class: "btn btn--linha", href: mailto, onclick: semArquivo, title: "Abre o aplicativo de e-mail padrão do computador" }, "Abrir no aplicativo padrão"),
          el("button", { class: "btn btn--linha", type: "button", onclick: copiar(d.texto, "Texto copiado.") }, "Copiar texto")))));
    const obs = new MutationObserver(() => { if (m.hidden) { obs.disconnect(); res(!parar); } });
    obs.observe(m, { attributes: true, attributeFilter: ["hidden"] });
  });
};

const nfEtiquetaSla = (m) => m.dias_uteis === null || m.dias_uteis === undefined ? el("span", { class: "etiqueta" }, "—")
  : el("span", { class: "etiqueta " + (m.sla_envio === "ATRASADO" ? (m.justificativa === "SEM" ? "etiqueta--alerta" : "etiqueta--aviso") : "etiqueta--ok"),
    title: m.sla_envio === "ATRASADO" ? (m.justificativa === "SEM" ? "Atrasada e sem observação" : "Atrasada, com observação") : "Dentro do prazo" }, `${m.dias_uteis}\u00a0d.u.`);
const nfEtiquetaStatus = (s) => el("span", { class: "etiqueta " + (s === "CANCELADA" ? "etiqueta--alerta" : s === "PENDENTE" ? "etiqueta--aviso" : "etiqueta--ok") }, NF_STATUS[s] || s);
const NF_ALERTA = {
  saldo_acabando: ["Saldo acabando", "etiqueta--alerta"], saldo_negativo: ["Saldo negativo", "etiqueta--alerta"],
  vencendo: ["Vencendo", "etiqueta--venc"], vencido: ["Vencido", "etiqueta--alerta"],
};
const nfAlertasContrato = (c) => c.alertas.length ? el("div", { class: "chips" }, c.alertas.map((a) => el("span", { class: "etiqueta " + NF_ALERTA[a][1] }, NF_ALERTA[a][0]))) : null;

/** Faixa de alertas (saldo acabando / vencimento) — leva para Contratos já filtrado. */
function nfFaixaAlertas() {
  const A = App.nf.base.alertas;
  if (!A.saldo.length && !A.vencimento.length) return null;
  const ir = (f) => {
    try { sessionStorage.setItem("nf_contr_filtro", f); } catch (e) { /* ok */ }
    if (location.hash === "#/nf/contratos") App.rotear(); else location.hash = "#/nf/contratos";
  };
  const C = App.nf.base.config;
  return el("div", { class: "alertas-nf" },
    A.saldo.length ? el("a", { class: "alerta-nf alerta-nf--saldo", onclick: () => ir("saldo") },
      el("i", { class: "alerta-ponto" }), el("span", {}, el("b", {}, `${A.saldo.length} contrato(s)`), ` com saldo acabando (até ${C.alerta_saldo_pct}% do total${+C.alerta_saldo_valor ? ` ou ${App.fmt.brl(+C.alerta_saldo_valor)}` : ""})`)) : null,
    A.vencimento.length ? el("a", { class: "alerta-nf alerta-nf--venc", onclick: () => ir("vencimento") },
      el("i", { class: "alerta-ponto alerta-ponto--aviso" }), el("span", {}, el("b", {}, `${A.vencimento.length} contrato(s)`), ` vencendo em até ${C.alerta_vencimento_dias} dias ou já vencidos`)) : null);
}

/* ------------------------------------------------------------------ MEDIÇÕES */
function nfMedicoes(corpo) {
  const est = { de: "", ate: "", q: "", status: "", sla: "", classe: "", pagina: 1, ordem: "medicao", dir: "desc" };
  try { Object.assign(est, JSON.parse(sessionStorage.getItem("nf_filtro_med") || "{}")); } catch (e) { /* ok */ }
  const salvar = () => { try { sessionStorage.setItem("nf_filtro_med", JSON.stringify(est)); } catch (e) { /* ok */ } };
  const sla = App.nf.cfg("sla_dias_uteis");
  App.exportarExcel = { rotulo: "Medições (com os filtros da tela)", url: () => "/api/nf/exportar?" + new URLSearchParams({ tipo: "medicoes",
    ...Object.fromEntries(Object.entries(est).filter(([k, v]) => v && ["de", "ate", "base", "q", "status", "sla", "classe", "cc", "projeto"].includes(k))) }) };

  const busca = el("input", { type: "search", placeholder: "Medição, NF, fornecedor, contrato ou observação…", value: est.q });
  const status = el("select", {}, el("option", { value: "" }, "Todos"), Object.entries(NF_STATUS).map(([k, r]) => el("option", { value: k, selected: est.status === k }, r)));
  const selSla = el("select", {}, [["", "Todos"], ["NO PRAZO", `No prazo (até ${sla} d.u.)`], ["ATRASADO", "Atrasadas"], ["SEM", "Atrasadas sem observação"]].map(([v, r]) => el("option", { value: v, selected: est.sla === v }, r)));
  const selClasse = el("select", {}, [["", "Todas"], ["sem", "Sem classe vinculada"], ["fora", "Fora do budget do ano"]].map(([v, r]) => el("option", { value: v, selected: est.classe === v }, r)));
  // período, centro de custo e projeto vêm do filtro comum das guias de Notas fiscais
  const sincFc = () => Object.assign(est, { de: App.nf.fc.de, ate: App.nf.fc.ate, base: App.nf.fc.base || "", cc: App.nf.fc.cc, projeto: App.nf.fc.projeto });
  sincFc();
  const atualizar = () => { sincFc(); Object.assign(est, { q: busca.value, status: status.value, sla: selSla.value, classe: selClasse.value, pagina: 1 }); salvar(); carregar(); };
  [status, selSla, selClasse].forEach((x) => (x.onchange = atualizar));
  let tb; busca.oninput = () => { clearTimeout(tb); tb = setTimeout(atualizar, 250); };
  const limpar = el("button", { class: "btn btn--linha btn--mini limpar" }, "Limpar filtros");
  limpar.onclick = () => { App.nf.limparFc(); busca.value = status.value = selSla.value = selClasse.value = ""; sincFc(); App.rotear(); };
  const btnPend = el("button", { class: "btn btn--linha", hidden: true, title: "Medições que prosseguiram e ainda não tiveram o e-mail gerado" });

  App.acoesCabecalho(App.nf.botaoImportar(), btnPend,
    el("button", { class: "btn btn--sec", onclick: nfSolicitarNfs, title: "E-mail para os fornecedores com a data limite para mandar as NFs do mês" }, "Solicitar NFs aos fornecedores"),
    el("button", { class: "btn", onclick: () => nfEditarMedicao({}) }, "+ Nova medição"));
  corpo.append(
    nfFaixaAlertas() || "",
    App.barraPadrao({ campos: [
      ...App.nf.camposFiltro(atualizar, { rotuloData: "Período", comBase: true }),
      App.campo("Status", status),
      App.campo(`SLA (${sla} dias úteis)`, selSla),
      App.campo("Classe financeira", selClasse)],
    busca, limpar: limpar.onclick }));
  const alvo = el("div");
  corpo.append(alvo);

  const colunas = [
    ["Medição / NF", "numero"], ["Fornecedor / contrato", "fornecedor"], ["Classe / centro de custo", null], ["Emissão", "emissao"], ["Vencimento", "vencimento"],
    ["Medição em", "medicao"], ["Valor", "valor", true], ["SLA", "dias"], ["Status", "status"], ["Ações", null, true],
  ];

  let foraIds = new Set();
  /* seleção em lote (continua valendo ao trocar de página) */
  const sel = new Set();
  const editavel = App.meta.editavel;
  let totalFiltro = 0;
  const btnTodasFiltro = el("button", { class: "btn btn--mini btn--linha" });
  btnTodasFiltro.onclick = async () => {
    const qs = new URLSearchParams(Object.fromEntries(Object.entries(est).filter(([k, v]) => v && ["de", "ate", "base", "q", "status", "sla", "classe", "cc", "projeto"].includes(k))));
    try { (await App.api("/api/nf/medicoes/ids?" + qs)).forEach((i) => sel.add(i)); barraSel.atualizar(); carregar(); } catch (e) { App.toast(e.message, true); }
  };
  const barraSel = App.barraSelecao(sel, { nome: "medição(ões)", aoLimpar: () => carregar(), acoes: [
    btnTodasFiltro,
    el("button", { class: "btn btn--mini btn--perigo", onclick: async () => {
      if (!(await App.confirmar("Excluir medições", `Excluir ${sel.size} medição(ões)? Os arquivos das NFs também são apagados. Não dá para desfazer.`, "Excluir"))) return;
      try { const r = await App.api("/api/nf/medicoes/excluir", { method: "POST", json: { ids: [...sel] } }); sel.clear(); barraSel.atualizar(); App.toast(`${r.n} medição(ões) excluída(s).`); carregar(); }
      catch (e) { App.toast(e.message, true); }
    } }, "Excluir selecionadas")] });
  const atualizarBarra = barraSel.atualizar;
  barraSel.atualizar = () => { atualizarBarra(); btnTodasFiltro.hidden = sel.size >= totalFiltro; btnTodasFiltro.textContent = `Selecionar todas as ${App.fmt.num(totalFiltro)} do filtro`; };
  const faixaBud = el("div");
  alvo.before(faixaBud);

  async function carregar(por = 100) {
    const qs = new URLSearchParams({ ...est, por, pagina: por > 100 ? 1 : est.pagina });
    let d;
    try { d = await App.api("/api/nf/medicoes?" + qs); } catch (e) { App.limpar(alvo).append(el("div", { class: "cartao vazio" }, e.message)); return; }
    if (por <= 100) { est.pagina = d.pagina; salvar(); desenharFora(); }
    btnPend.hidden = !d.pendentes_email;
    btnPend.textContent = `E-mails pendentes (${d.pendentes_email})`;
    btnPend.onclick = () => nfEmailsPendentes();
    const k = d.kpis, validas = k.n - k.canceladas;
    App.limpar(alvo);
    const sc = d.sem_classe;
    if (sc && sc.n) {
      alvo.append(el("div", { class: "alertas-nf" }, el("a", { class: "alerta-nf alerta-nf--saldo", onclick: () => { selClasse.value = est.classe === "sem" ? "" : "sem"; atualizar(); } }, el("i", { class: "alerta-ponto" }),
        el("span", {}, el("b", {}, `${sc.n} medição(ões) sem classe financeira vinculada`), ` (${App.fmt.brl(sc.valor)})`,
          " — " + [sc.multi ? `${sc.multi} de contrato com mais de uma linha (abra a medição e escolha o item)` : "",
            sc.n - sc.multi ? `${sc.n - sc.multi} de contrato sem linha/classe cadastrada (cadastre em Contratos)` : ""].filter(Boolean).join(" · ") + ".",
          el("b", {}, est.classe === "sem" ? " Mostrar todas →" : " Mostrar só essas →")))));
    }
    alvo.append(el("div", { class: "kpis" },
      App.kpi("Medições", App.fmt.num(validas), "core", `${k.canceladas} cancelada(s) no filtro`),
      App.kpi("Valor medido", App.fmt.brlCurto(k.valor), "p900", "sem as canceladas"),
      App.kpi(`No prazo (${sla} dias úteis)`, App.fmt.pct(k.com_sla ? 100 * k.no_prazo / k.com_sla : null), "g200", `${k.no_prazo} de ${k.com_sla} · da emissão até a medição`),
      App.kpi("Atrasadas sem observação", App.fmt.num(k.sem_just), k.sem_just ? "p100" : "branco", k.sem_just ? "preencha o motivo do atraso" : "tudo justificado")));

    totalFiltro = d.total;
    const caixasPagina = [];
    const thead = el("tr", {}, editavel ? el("th", { class: "col-sel" }, App.caixaSel(d.itens.length && d.itens.every((m) => sel.has(m.id)), (v) => {
      d.itens.forEach((m) => (v ? sel.add(m.id) : sel.delete(m.id))); caixasPagina.forEach((c) => (c.checked = v)); barraSel.atualizar();
    }, "Selecionar todas desta página")) : null, colunas.map(([rot, chave, num]) => {
      const th = el("th", { class: (num ? "num " : "") + (chave ? "ordena " : "") + (est.ordem === chave ? (est.dir === "asc" ? "asc" : "desc") : "") }, rot);
      if (chave) th.onclick = () => { est.dir = est.ordem === chave && est.dir === "desc" ? "asc" : "desc"; est.ordem = chave; est.pagina = 1; salvar(); carregar(); };
      return th;
    }));
    const linhas = d.itens.map((m) => {
      const cx = editavel ? App.caixaSel(sel.has(m.id), (v) => { v ? sel.add(m.id) : sel.delete(m.id); barraSel.atualizar(); }) : null;
      if (cx) caixasPagina.push(cx);
      const tr = el("tr", { class: "clicavel" },
        editavel ? el("td", { class: "col-sel" }, cx) : null,
        el("td", {}, el("div", { class: "celula-2l" }, el("b", {}, m.numero_medicao || "—"),
          el("small", {}, m.tem_anexo ? el("a", { href: `/api/nf/medicoes/${m.id}/anexo`, target: "_blank", title: "Abrir o arquivo da NF" }, `NF ${m.numero_documento || ""}`.trim())
            : el("span", { title: "Sem arquivo da NF" }, m.numero_documento ? `NF ${m.numero_documento}` : "sem NF")))),
        el("td", {}, el("div", { class: "celula-2l" }, el("span", {}, m.fornecedor || "—"),
          el("small", {}, m.pedido && !m.contrato ? `Pedido de compra ${m.pedido}` : `Contrato ${m.contrato || "—"}${m.item_numero || m.item_descricao ? ` · item ${m.item_numero || m.item_descricao}` : ""}`),
          foraIds.has(m.id) ? el("span", { class: "etiqueta etiqueta--alerta", style: { alignSelf: "flex-start", marginTop: "3px" },
            title: "Centro de custo / projeto / classe desta medição não está no budget do ano: o valor não está sendo calculado" }, "Fora do budget") : null)),
        el("td", {}, (m.rateio || m.rateio_pedido) ? nfCelulaRateio(m.rateio || m.rateio_pedido, !m.rateio) : m.classe_numero ? el("div", { class: "celula-2l" },
          el("span", {}, el("b", {}, m.classe_numero), " ", (m.classe_descricao || "").replace(/^CUSTOS - /, "")),
          el("small", {}, `CC ${m.classe_cc || "—"}${m.classe_cc_desc ? " — " + m.classe_cc_desc : ""} · projeto ${m.classe_projeto || "—"}`))
          : el("span", { class: "etiqueta etiqueta--alerta", title: m.n_itens_contrato > 1 ? "O contrato tem mais de uma linha: abra a medição e escolha o item" : "Contrato sem linha/classe cadastrada" },
            m.n_itens_contrato > 1 ? `Sem classe · ${m.n_itens_contrato} linhas` : "Sem classe")),
        el("td", {}, nfData(m, "data_emissao")),
        el("td", {}, nfData(m, "data_vencimento")),
        el("td", {}, nfData(m, "data_medicao")),
        el("td", { class: "num" }, App.fmt.brl(m.valor)),
        el("td", {}, nfEtiquetaSla(m)),
        el("td", {}, nfEtiquetaStatus(m.status)),
        el("td", {}, el("div", { class: "acoes-linha acoes-linha--pilha" },
          el("button", { class: "btn btn--mini btn--linha", title: "Editar a medição", onclick: () => nfEditarMedicao(m) }, "Editar"),
          el("button", {
            class: "btn btn--mini " + (m.email_gerado_em ? "btn--linha" : "btn--sec"), disabled: m.status === "CANCELADA",
            title: m.email_gerado_em ? `Último envio: ${m.email_gerado_em === "planilha" ? "pela planilha antiga" : App.fmt.data(m.email_gerado_em.slice(0, 10)) + " " + m.email_gerado_em.slice(11, 16)}` : "Gerar o e-mail com a NF anexada",
            onclick: async () => { if (await App.nf.baixarEmail(`/api/nf/medicoes/${m.id}/email`)) carregar(); },
          }, m.email_gerado_em ? "Reenviar" : "Enviar e-mail"))));
      tr.onclick = (ev) => { if (!ev.target.closest("button, a, input")) nfEditarMedicao(m); };
      return tr;
    });
    const pag = el("div", { class: "paginacao" },
      el("span", {}, d.total ? `${(d.pagina - 1) * d.por + 1}–${Math.min(d.pagina * d.por, d.total)} de ${App.fmt.num(d.total)}` : ""),
      el("button", { class: "btn btn--linha btn--mini", disabled: d.pagina <= 1, onclick: () => { est.pagina = d.pagina - 1; carregar(); } }, "← Anterior"),
      el("span", {}, `Página ${d.pagina} de ${d.paginas}`),
      el("button", { class: "btn btn--linha btn--mini", disabled: d.pagina >= d.paginas, onclick: () => { est.pagina = d.pagina + 1; carregar(); } }, "Próxima →"));
    barraSel.atualizar();
    alvo.append(App.cartao("Medições", `${App.fmt.num(d.total)} registro(s) · clique numa linha ou em Editar para alterar${editavel ? " · marque as caixas para excluir várias" : ""}`,
      barraSel,
      el("div", { class: "tabela-wrap tabela-wrap--alta" }, el("table", { class: "tabela tabela--densa" }, el("thead", {}, thead),
        el("tbody", {}, linhas.length ? linhas : el("tr", {}, el("td", { colspan: colunas.length + (editavel ? 1 : 0), class: "vazio" }, "Nenhuma medição para os filtros escolhidos."))))),
      pag));
  }
  /* aviso "fora do budget do ano": refeito a cada mudança de filtro, contando só as medições do filtro atual */
  async function desenharFora() {
    if (!nfTemBudget()) return;
    let d;
    try { d = await App.api("/api/nf/medicoes?" + new URLSearchParams({ ...Object.fromEntries(Object.entries(est).filter(([k, v]) => v && ["de", "ate", "base", "cc", "projeto"].includes(k))), classe: "fora", por: 10 })); }
    catch (e) { return; }
    App.limpar(faixaBud);
    if (!d.total) return;
    const valor = d.kpis.valor;
    faixaBud.append(el("div", { class: "alertas-nf" }, el("a", { class: "alerta-nf alerta-nf--saldo",
      onclick: () => { selClasse.value = est.classe === "fora" ? "" : "fora"; atualizar(); } },
      el("i", { class: "alerta-ponto" }),
      el("span", {}, el("b", {}, `${d.total} medição(ões) (${App.fmt.brl(valor)})`),
        " com centro de custo / projeto / classe que não está no budget do ano — o valor não está sendo calculado. Corrija a classe da medição ou crie a linha no Budget.",
        el("b", { class: "acao-fora" }, est.classe === "fora" ? " Mostrar todas →" : " Mostrar só essas →")))));
  }
  if (nfTemBudget()) {
    App.api("/api/budget/fora").then((f) => { foraIds = new Set(f.medicoes); }).catch(() => {}).finally(() => carregar());
  } else carregar();
  // PDF: imprime todas as medições do filtro (até 2.000), depois volta para a página normal
  App.antesDeExportar = async () => { await carregar(2000); return () => carregar(); };
  App.soltarNaPagina(null, () => App.rotear(), {
    enviar: (files) => {
      const pdfs = [...files].filter((f) => /\.pdf$/i.test(f.name));
      if (pdfs.length) return App.nf.pedidosDoPdf(pdfs);
      return App.importacao.importar(files);
    },
    texto: "Planilha de importação (ou a EnviarEmailNF antiga) — ou o PDF do pedido de compra, para lançar a NF do pedido",
  });
}

/** Classe da NF rateada: etiqueta "Rateio" + as partes (classe · centro de custo · %). */
function nfCelulaRateio(txt, doPedido) {
  const partes = txt.split(" | ");
  return el("div", { class: "celula-2l", title: (doPedido ? "Rateio do pedido: " : "Rateio da NF: ") + partes.join("; ") },
    el("span", { class: "etiqueta etiqueta--rateio", style: { alignSelf: "flex-start" } }, `Rateio · ${partes.length} partes${doPedido ? " (do pedido)" : ""}`),
    ...partes.slice(0, 3).map((x) => el("small", {}, x.replace(/\.(\d\d)%$/, ",$1%"))), partes.length > 3 ? el("small", {}, `+ ${partes.length - 3}`) : null);
}

/** Data na tabela de medições. A data que vale para o filtro de período fica em negrito; se outra data da mesma NF
    é de outro ano (ex.: NF emitida em 2025 e medida em 2026), aparece o aviso, para ficar claro por que ela entrou no filtro. */
function nfData(m, campo) {
  const base = { emissao: "data_emissao", vencimento: "data_vencimento" }[App.nf.fc.base] || "data_medicao";
  const v = m[campo];
  if (!v) return "—";
  const ref = m[base] || m.data_emissao || m.data_medicao;
  const txt = App.fmt.dataCurta(v);
  if (campo === base) return el("b", { title: "Data usada no filtro de período" }, txt);
  if (ref && v.slice(0, 4) !== ref.slice(0, 4) && campo !== "data_vencimento")
    return el("div", { class: "celula-2l" }, el("span", {}, txt), el("small", { class: "aviso-ano", title: `A data usada no filtro de período é de ${ref.slice(0, 4)}` }, `conta em ${ref.slice(0, 4)}`));
  return txt;
}

/* ------------------------------------------------------------------ importar a planilha EnviarEmailNF */
/** PDF(s) de pedido de compra soltos na página: cadastra os pedidos; com um só, já abre a NF desse pedido. */
App.nf.pedidosDoPdf = async function (pdfs) {
  const rs = await App.enviarArquivos("/api/nf/pedido-pdf", pdfs);
  const ok = rs.filter((r) => !r.erro);
  rs.filter((r) => r.erro).forEach((r) => App.toast(`${r.arquivo}: ${r.erro}`, true));
  if (ok.length === 1) { nfEditarMedicao({ pedido_id: ok[0].pedido.id, pedido: ok[0].pedido.numero }); return; }
  if (ok.length) App.toast(`${ok.length} pedido(s) cadastrado(s) a partir do PDF.`);
};

/* importar: a mesma planilha única do site (também aceita a EnviarEmailNF antiga) */
App.nf.botaoImportar = () => App.importacao.botoes();
App.nf.botaoModelo = () => null;
App.nf.importarPlanilha = (files) => App.importacao.importar(files);

async function nfEmailsPendentes() {
  const d = await App.api("/api/nf/medicoes?email=pendente&por=500&ordem=medicao&dir=asc");
  if (!d.itens.length) { App.toast("Nenhum e-mail pendente."); return; }
  if (!(await App.confirmar("Gerar e-mails pendentes", `Vou abrir ${d.itens.length} e-mail(s), um por medição, para enviar pelo Outlook. Se o navegador perguntar, permita baixar vários arquivos.`, "Gerar"))) return;
  for (const [i, m] of d.itens.entries()) { if (!(await App.nf.baixarEmail(`/api/nf/medicoes/${m.id}/email`, { lote: `${i + 1} de ${d.itens.length}` }))) break; }
  App.rotear();
}

function nfSolicitarNfs() {
  const mesAtual = App.hoje().slice(0, 7);
  const prazoExistente = (mes) => App.nf.base.prazos.find((p) => p.mes === mes)?.prazo || "";
  const mes = el("input", { type: "month", value: mesAtual });
  const prazo = el("input", { type: "date", value: prazoExistente(mesAtual) });
  mes.onchange = () => { prazo.value = prazoExistente(mes.value) || prazo.value; };
  const C = App.nf.base.config;
  const msg = el("p", { class: "ajuda", style: { color: "var(--perigo)", minHeight: "18px" } });
  App.modal(el("div", {}, el("h3", {}, "Solicitar NFs aos fornecedores"),
    el("p", { class: "ajuda", style: { marginTop: 0 } }, "Gera o e-mail avisando a data limite para os fornecedores mandarem as notas fiscais do mês. O prazo fica salvo e é usado no gráfico de fornecedores dentro do prazo."),
    el("div", { class: "grade", style: { gap: "10px", gridTemplateColumns: "1fr 1fr" } },
      el("label", { class: "campo" }, el("span", {}, "Mês das notas"), mes),
      el("label", { class: "campo" }, el("span", {}, "Data limite"), prazo)),
    el("p", { class: "ajuda" }, "Destinatários (Configurações): ",
      [["Para", C.email_forn_para], ["Cc", C.email_forn_cc], ["Cco", C.email_forn_cco]].filter(([, v]) => v).map(([r, v]) => `${r}: ${v}`).join(" · ") || "nenhum — você coloca no Outlook"),
    msg,
    el("div", { class: "linha-acoes" }, el("button", { class: "btn", onclick: async () => {
      if (!mes.value || !prazo.value) { msg.textContent = "Informe o mês e a data limite."; return; }
      try {
        await App.api("/api/nf/prazos", { method: "POST", json: { mes: mes.value, prazo: prazo.value } });
        if (await App.nf.baixarEmail(`/api/nf/prazos/${mes.value}/email`)) { App.fecharModal(); App.rotear(); }
      } catch (e) { msg.textContent = e.message; }
    } }, "Gerar e-mail"), el("button", { class: "btn btn--linha", "data-fechar": "" }, "Cancelar"))));
}

/* ------------------------------------------------------------------ budget (só para quem tem a guia Budget) */
const nfTemBudget = () => (App.meta.acessos || []).includes("budget");

/** Bloco do contrato: classe padrão + itens (linhas), cada item com centro de custo / projeto / classe. */
async function nfBudgetContrato(c) {
  if (!nfTemBudget()) return null;
  try { await App.bud.carregarBase(); } catch (e) { return null; }
  const d = c.id ? await App.api(`/api/budget/contrato/${c.id}`) : { padrao: null, itens: [] };
  const anoAtual = () => String(new Date().getFullYear());
  const padrao = App.bud.camposClasse(d.padrao || {}, { ano: anoAtual });
  const lista = el("div", { class: "itens-contrato" });
  const linhas = [];
  const vazio = el("p", { class: "ajuda", style: { margin: 0 } }, "Nenhum item: todas as medições usam a classe padrão.");
  const addLinha = (it = {}) => {
    vazio.remove();
    const num = el("input", { type: "text", value: it.numero || "", placeholder: "ex.: 10" });
    const desc = el("input", { type: "text", value: it.descricao || "", placeholder: "ex.: manutenção elétrica" });
    const cps = App.bud.camposClasse(it, { ano: anoAtual });
    const lab = (t, x) => el("label", { class: "campo" }, el("span", {}, t), x);
    const linha = { it, num, desc, cps, removido: false };
    const box = el("div", { class: "item-contrato" },
      el("div", { class: "item-contrato__linha" }, lab("Item", num), lab("Descrição", desc), ...cps.campos(),
        el("button", { class: "btn btn--mini btn--linha", title: "Tirar este item", onclick: () => {
          linha.removido = true; box.remove();
          if (it.n_medicoes) App.toast(`${it.n_medicoes} medição(ões) usavam este item: ao salvar, voltam para a classe padrão do contrato.`, true);
        } }, "✕")),
      cps.aviso,
      it.n_medicoes ? el("div", { class: "ajuda" }, `${it.n_medicoes} medição(ões) usam este item`) : null);
    linhas.push(linha);
    lista.append(box);
  };
  d.itens.forEach(addLinha);
  if (!d.itens.length) lista.append(vazio);
  const bloco = el("div", { class: "bloco-budget campo--largo" }, el("h4", {}, "Budget · classe financeira"),
    el("p", { class: "ajuda", style: { marginTop: 0 } }, "A classe padrão vale para todas as medições do contrato. Se o contrato tem itens (linhas) com projeto ou classe diferentes, cadastre os itens e escolha o item em cada medição."),
    el("div", { class: "grade-form" }, padrao.campos(), el("div", { class: "campo campo--largo" }, padrao.aviso)),
    el("h4", { style: { marginTop: "12px" } }, "Itens (linhas) do contrato"),
    lista,
    el("div", { class: "linha-acoes", style: { marginTop: "8px", alignItems: "center" } },
      el("button", { class: "btn btn--mini btn--linha", onclick: () => addLinha() }, "+ Adicionar item"), App.bud.linkCadastros()));
  return {
    bloco,
    validar: () => {
      const nums = linhas.filter((l) => !l.removido).map((l) => l.num.value.trim()).filter(Boolean);
      const rep = [...new Set(nums.filter((n, i) => nums.indexOf(n) !== i))];
      return rep.length ? `Item repetido no contrato: ${rep.join(", ")}. Cada item precisa de um número diferente.` : "";
    },
    salvar: (cid) => App.api(`/api/budget/contrato/${cid}`, { method: "POST", json: { padrao: padrao.valores(),
      itens: linhas.filter((l) => !l.removido).map((l) => ({ id: l.it.id, numero: l.num.value, descricao: l.desc.value, ...l.cps.valores() })) } }),
  };
}

/** Bloco da medição: item (linha) do contrato, ou outra classe só nesta medição; mostra para onde vai no budget. */
async function nfBudgetMedicao(m, contratoSel, anoFn, totalFn) {
  if (!nfTemBudget()) return null;
  try { await App.bud.carregarBase(); } catch (e) { return null; }
  let rateioIni = [];
  if (m.id) { try { rateioIni = await App.api(`/api/budget/rateio?tipo=medicao&id=${m.id}`); } catch (e) { /* ok */ } }
  const rat = App.bud.rateio(rateioIni, { total: totalFn, ano: anoFn, titulo: "Ratear esta NF entre centros de custo / classes financeiras", base: "valor da NF" });
  const cache = {};
  const buscar = async (cid) => (cid ? (cache[cid] = cache[cid] || await App.api(`/api/budget/contrato/${cid}`)) : { padrao: null, itens: [] });
  const selItem = el("select");
  // classe só desta medição (com rateio, a classe gravada na medição é só a da maior parte: não conta como "outra classe")
  const outra = el("input", { type: "checkbox", checked: !!m.budget_item_id && rateioIni.length < 2, style: { width: "auto", margin: 0 } });
  const atual = (m.budget_item_id && App.bud.base.itens.find((i) => i.id === m.budget_item_id)) || {};
  const destino = el("div");
  let info = { padrao: null, itens: [] };
  let pronto = false;   // camposClasse já chama aoMudar ao ser criado, antes de "cps" existir
  const cps = App.bud.camposClasse(atual, { semAviso: true, aoMudar: () => pronto && resumo() });
  pronto = true;
  const camposOutra = el("div", { class: "grade-form", hidden: !outra.checked }, cps.campos());
  function resumo() {
    let v = null, origem = "";
    const it = info.itens.find((i) => String(i.id) === selItem.value);
    if (outra.checked && cps.cl.value) { v = cps.valores(); origem = "classe só desta medição"; }
    else if (it && it.classe_numero) { v = it; origem = `item ${it.numero || it.descricao} do contrato`; }
    else if (info.itens.length && info.itens.every((i) => i.budget_item_id && i.budget_item_id === info.itens[0].budget_item_id)) {
      v = info.itens[0]; origem = info.itens.length === 1 ? `item ${v.numero || v.descricao} (único item do contrato)` : "classe dos itens do contrato (todos iguais)";
    }
    else if (info.padrao) { v = info.padrao; origem = "classe padrão do contrato"; }
    App.limpar(destino);
    if (!v) {
      if (contratoSel.value) destino.append(el("div", { class: "aviso-budget aviso-budget--alerta" }, "Sem classe financeira (nem no contrato): esta medição não entra no budget."));
      return;
    }
    const cl = App.bud.base.cadastros.classes.find((x) => x.numero === v.classe_numero);
    destino.append(el("div", { class: "ajuda", style: { margin: "6px 0 2px" } },
      `Entra no budget pela ${origem}: ${v.classe_numero} ${(cl && cl.descricao) || v.classe_descricao || ""} · ${App.bud.rotPj(v.projeto) || "sem projeto"} · ${App.bud.rotCc(v.centro_custo) || "sem centro de custo"}`),
      App.bud.aviso(App.bud.situacao(v.centro_custo, v.projeto, v.classe_numero, anoFn())));
  }
  async function carregarItens(manter) {
    try { info = await buscar(+contratoSel.value || 0); } catch (e) { info = { padrao: null, itens: [] }; }
    const atualItem = manter ? m.contrato_item_id : null;
    const iguais = info.itens.length && info.itens.every((i) => i.budget_item_id && i.budget_item_id === info.itens[0].budget_item_id);
    const pd = info.padrao && info.padrao.classe_numero ? ` (${info.padrao.classe_numero} · ${App.bud.rotPj(info.padrao.projeto) || "sem projeto"})` : "";
    App.limpar(selItem).append(el("option", { value: "" }, !info.itens.length ? (pd ? `— classe padrão do contrato${pd}` : "— contrato sem itens nem classe padrão: cadastre em Contratos")
      : iguais ? "— automático (todos os itens têm a mesma classe)" : "— contrato inteiro (classe padrão)"),
      ...info.itens.map((i) => el("option", { value: i.id, selected: i.id === atualItem },
        `Item ${i.numero || "—"}${i.descricao ? " · " + i.descricao : ""}${i.classe_numero ? `  (${i.classe_numero} · ${App.bud.rotPj(i.projeto) || "sem projeto"})` : ""}`)));
    selItem.disabled = !info.itens.length;
    resumo();
  }
  outra.onchange = () => { camposOutra.hidden = !outra.checked; resumo(); };
  selItem.onchange = resumo;
  contratoSel.addEventListener("change", () => carregarItens(false));
  await carregarItens(true);
  const campoItem = el("label", { class: "campo" }, el("span", {}, "Item (linha) do contrato"), selItem);
  const ligaOutra = el("label", { style: { display: "flex", gap: "8px", alignItems: "center", fontSize: "16px", margin: "8px 0 4px" } }, outra, "Usar outra classe só nesta medição");
  const classeUnica = el("div", {}, ligaOutra, camposOutra, destino);
  const mostrarRateio = () => { classeUnica.hidden = rat.ativo(); };
  rat.bloco.querySelector("input[type=checkbox]").addEventListener("change", mostrarRateio);
  mostrarRateio();
  const bloco = el("div", { class: "bloco-budget campo--largo" }, el("h4", {}, "Budget · classe financeira"),
    campoItem, classeUnica, rat.bloco);
  return {
    bloco, atualizar: () => { resumo(); rat.atualizar(); },
    validar: () => rat.validar(),
    salvar: async (mid) => {
      const r = await App.api("/api/budget/vincular", { method: "POST", json: { tipo: "medicao", id: mid, contrato_item_id: selItem.value || null,
        ...(outra.checked && !rat.ativo() ? cps.valores() : { centro_custo: "", projeto: "", classe_numero: "" }) } });
      if (rat.ativo() || rateioIni.length) await App.bud.salvarRateio("medicao", mid, rat);
      return r;
    },
  };
}

async function nfSalvarBudget(bloco, id) {
  if (!bloco || !id) return null;
  try { return await bloco.salvar(id); } catch (e) { App.toast("Salvo, mas não consegui gravar a classe / o rateio do budget: " + e.message, true); return null; }
}

async function nfEditarMedicao(m) {
  const B = App.nf.base;
  const novo = !m.id;
  const sla = App.nf.cfg("sla_dias_uteis");
  const inp = (tipo, v, extra = {}) => el("input", { type: tipo, value: v ?? "", ...extra });
  const numMed = inp("text", m.numero_medicao, { placeholder: "ex.: 10001" });
  const numDoc = inp("text", m.numero_documento, { placeholder: "nº da NF" });
  const emissao = inp("date", m.data_emissao), venc = inp("date", m.data_vencimento), medicao = inp("date", m.data_medicao || (novo ? App.hoje() : ""));
  const valor = inp("number", m.valor, { step: "0.01", min: "0" });
  const ativos = B.contratos.filter((c) => !c.finalizado || c.id === m.contrato_id);
  const contrato = el("select", {}, el("option", { value: "" }, "Escolha o contrato…"),
    ativos.map((c) => el("option", { value: c.id, selected: c.id === m.contrato_id },
      `${c.numero} — ${c.fornecedor}${c.finalizado ? " (finalizado)" : ""}${c.alertas.length ? " · " + c.alertas.map((a) => NF_ALERTA[a][0].toLowerCase()).join(", ") : ""}`)));
  const status = el("select", {}, Object.entries(NF_STATUS).map(([k, r]) => el("option", { value: k, selected: (m.status || "PROSSEGUIU") === k }, r)));
  const obs = el("textarea", { rows: 3, placeholder: "Motivo do atraso, pendências etc." }, m.observacao || "");
  /* NF de contrato ou de pedido de compra (material / serviço avulso, sem contrato) */
  let modo = m.pedido_id ? "pedido" : "contrato";
  let pedidos = [];
  try { pedidos = await App.api("/api/nf/pedidos"); } catch (e) { /* sem pedidos */ }
  const listaPed = el("datalist", { id: "nf-pedidos" });
  const encherPedidos = () => App.limpar(listaPed).append(...pedidos.map((p) => el("option", { value: p.numero },
    `${p.fornecedor || "sem fornecedor"} · ${App.fmt.brl(p.valor)}${p.status === "CANCELADO" ? " · cancelado" : ""}`)));
  encherPedidos();
  const pedAtual = pedidos.find((p) => p.id === m.pedido_id);
  const pedidoInp = inp("text", pedAtual ? pedAtual.numero : (m.pedido || ""), { list: "nf-pedidos", placeholder: "nº do pedido (ex.: 20001)" });
  const pedidoSel = () => pedidos.find((p) => p.numero === pedidoInp.value.trim());
  const infoPedido = el("div", { class: "ajuda" });
  const pdfInp = el("input", { type: "file", accept: ".pdf", hidden: true });
  pdfInp.onchange = async () => {
    if (!pdfInp.files[0]) return;
    App.toast("Lendo o PDF do pedido…");
    const [r] = await App.enviarArquivos("/api/nf/pedido-pdf", [pdfInp.files[0]]);
    pdfInp.value = "";
    if (r.erro) { App.toast(r.erro, true); return; }
    const p = r.pedido;
    pedidos = [p, ...pedidos.filter((x) => x.id !== p.id)];
    encherPedidos();
    pedidoInp.value = p.numero;
    App.toast(r.novo ? `Pedido ${p.numero} cadastrado (${p.fornecedor}).` : `Pedido ${p.numero} já existia: completei o que faltava.`);
    aoMudarPedido();
  };
  const aoMudarPedido = () => {
    const p = pedidoSel();
    if (!p) { infoPedido.textContent = pedidoInp.value ? "Pedido não encontrado: leia o PDF do pedido ou cadastre em Notas fiscais › Pedidos de compra." : ""; infoPedido.style.color = pedidoInp.value ? "var(--perigo)" : ""; return; }
    const medidoOutras = p.medido - (m.pedido_id === p.id && m.status !== "CANCELADA" ? m.valor || 0 : 0);
    const saldo = (p.valor || 0) - medidoOutras;
    if (!valor.value && saldo > 0) valor.value = saldo.toFixed(2);   // puxa o saldo do pedido
    infoPedido.style.color = "";
    infoPedido.textContent = `Fornecedor: ${p.fornecedor || "—"} · pedido ${App.fmt.brl(p.valor)} · já medido ${App.fmt.brl(medidoOutras)} · saldo ${App.fmt.brl(saldo)}`
      + (p.descricao ? ` · ${p.descricao.slice(0, 90)}` : "");
  };
  pedidoInp.addEventListener("input", aoMudarPedido);
  pedidoInp.addEventListener("change", aoMudarPedido);
  pedidoInp.addEventListener("change", () => montarRateioPedido());
  const arquivo = el("input", { type: "file", accept: ".pdf,.png,.jpg,.jpeg,.xml,.zip" });
  const infoSaldo = el("div", { class: "ajuda" });
  const infoSla = el("div", { class: "ajuda" });
  const calcular = () => {
    const c = B.contratos.find((x) => x.id === +contrato.value);
    if (c) {
      const devolve = m.contrato_id === c.id && m.status !== "CANCELADA" ? m.valor || 0 : 0;
      const depois = c.saldo_atual + devolve - (status.value === "CANCELADA" ? 0 : +valor.value || 0);
      const avisos = [];
      if (c.dias_para_vencer !== null && c.dias_para_vencer < 0) avisos.push(`contrato venceu há ${-c.dias_para_vencer} dias`);
      else if (c.alertas.includes("vencendo")) avisos.push(`contrato vence em ${c.dias_para_vencer} dias`);
      infoSaldo.textContent = `Saldo atual do contrato: ${App.fmt.brl(c.saldo_atual + devolve)} → ${App.fmt.brl(depois)} depois desta medição` + (avisos.length ? ` · atenção: ${avisos.join(" · ")}` : "");
      infoSaldo.style.color = depois < 0 || avisos.length ? "var(--perigo)" : "";
    } else infoSaldo.textContent = "";
    const du = App.nf.diasUteis(emissao.value, medicao.value);
    if (du === null) { infoSla.textContent = ""; return; }
    const atrasou = du > sla;
    infoSla.textContent = `${du} dia(s) útil(eis) entre a emissão e a medição — ${atrasou ? `ATRASADA (mais de ${sla} dias úteis): preencha a observação com o motivo.` : "dentro do prazo."}`;
    infoSla.style.color = atrasou && !obs.value.trim() ? "var(--perigo)" : "";
  };
  [contrato, valor, emissao, medicao, obs, status].forEach((x) => x.addEventListener("input", calcular));
  const cb = await nfBudgetMedicao(m, contrato, () => (medicao.value || emissao.value || "").slice(0, 4), () => +valor.value || 0);
  if (cb) [emissao, medicao, valor].forEach((x) => x.addEventListener("input", cb.atualizar));
  /* NF de pedido: o budget conta o PEDIDO, então o rateio é o do pedido (vale para todas as NFs dele) */
  const rateioPedBox = el("div", { class: "bloco-budget campo--largo", hidden: true });
  let ratPed = null, ratPedId = null, ratPedIni = [];
  const montarRateioPedido = async () => {
    const p = pedidoSel();
    if (!cb || !p) { rateioPedBox.hidden = true; ratPed = null; ratPedId = null; return; }
    if (ratPedId === p.id) return;
    ratPedId = p.id;
    try { ratPedIni = await App.api(`/api/budget/rateio?tipo=pedido&id=${p.id}`); } catch (e) { ratPedIni = []; }
    if (ratPedId !== p.id) return;
    ratPed = App.bud.rateio(ratPedIni, { total: () => p.valor || 0, ano: () => (p.data_emissao || "").slice(0, 4),
      titulo: `Ratear o pedido ${p.numero} entre centros de custo / classes financeiras`, base: `valor do pedido (${App.fmt.brl(p.valor)}) — vale para todas as NFs dele` });
    App.limpar(rateioPedBox).append(el("h4", {}, "Budget · rateio do pedido"), ratPed.bloco);
    rateioPedBox.hidden = modo !== "pedido";
  };
  const campoContrato = el("label", { class: "campo campo--largo" }, el("span", {}, "Contrato + fornecedor"), contrato, infoSaldo);
  const campoPedido = el("div", { class: "campo campo--largo" }, el("span", {}, "Pedido de compra (o fornecedor vem do pedido)"), listaPed,
    el("div", { style: { display: "flex", gap: "8px" } }, el("div", { style: { flex: 1 } }, pedidoInp), pdfInp,
      el("button", { class: "btn btn--linha", type: "button", onclick: () => pdfInp.click(), title: "Lê o PDF do pedido de compra e cadastra o pedido (nº, fornecedor, valor…)" }, "Ler PDF do pedido")),
    infoPedido);
  const notaBudgetPedido = el("div", { class: "aviso-budget aviso-budget--ok campo--largo" }, "NF de pedido: entra no budget pelo pedido (o valor do pedido já está no incorrido, não soma de novo).");
  const chips = ["contrato", "pedido"].map((k) => {
    const b = el("button", { class: "chip", type: "button", "aria-pressed": String(modo === k) }, k === "contrato" ? "Contrato" : "Pedido de compra");
    b.onclick = () => { modo = k; mostrarModo(); };
    return b;
  });
  const mostrarModo = () => {
    chips.forEach((b, i) => b.setAttribute("aria-pressed", String(["contrato", "pedido"][i] === modo)));
    campoContrato.hidden = modo !== "contrato";
    campoPedido.hidden = modo !== "pedido";
    if (cb) cb.bloco.hidden = modo !== "contrato";
    notaBudgetPedido.hidden = modo !== "pedido" || !cb;
    rateioPedBox.hidden = modo !== "pedido" || !ratPed;
    if (modo === "pedido") { aoMudarPedido(); montarRateioPedido(); } else calcular();
  };
  const msg = el("p", { class: "ajuda", style: { color: "var(--perigo)", minHeight: "18px" } });
  const anexoAtual = m.tem_anexo ? el("a", { href: `/api/nf/medicoes/${m.id}/anexo`, target: "_blank" }, "" + (m.anexo_nome || (m.caminho_externo || "").split(/[\\/]/).pop() || "ver NF")) : null;
  const enviar = async (comEmail) => {
    const fd = new FormData();
    let pedidoId = "";
    if (modo === "pedido") {
      const p = pedidoSel();
      if (!p) { msg.textContent = "Escolha um pedido da lista (ou leia o PDF do pedido)."; return; }
      pedidoId = p.id;
      const e = ratPed && ratPedId === p.id && ratPed.validar();
      if (e) { msg.textContent = e; return; }
    } else if (cb) {
      const e = cb.validar();
      if (e) { msg.textContent = e; return; }
    }
    Object.entries({ id: m.id || "", numero_medicao: numMed.value, numero_documento: numDoc.value, data_emissao: emissao.value,
      data_vencimento: venc.value, data_medicao: medicao.value, valor: valor.value, contrato_id: modo === "contrato" ? contrato.value : "",
      pedido_id: pedidoId, observacao: obs.value, status: status.value }).forEach(([k, v]) => fd.append(k, v));
    if (arquivo.files[0]) fd.append("arquivo", arquivo.files[0]);
    try {
      const r = await fetch("/api/nf/medicoes", { method: "POST", body: fd });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.erro || `Erro ${r.status}`);
      if (modo === "contrato") await nfSalvarBudget(cb, d.id);
      else if (ratPed && ratPedId === +pedidoId && (ratPed.ativo() || ratPedIni.length)) {
        try { await App.bud.salvarRateio("pedido", ratPedId, ratPed); } catch (e) { App.toast("NF salva, mas o rateio do pedido não: " + e.message, true); }
      }
      App.fecharModal();
      if (comEmail) await App.nf.baixarEmail(`/api/nf/medicoes/${d.id}/email`);
      else App.toast(novo ? "Medição lançada." : "Medição salva.", false, novo ? { acao: { rotulo: "Lançar outra", fazer: () => nfEditarMedicao({}) } } : {});
      App.rotear();
    } catch (e) { msg.textContent = e.message; }
  };
  const ultimoEnvio = m.email_gerado_em ? (m.email_gerado_em === "planilha" ? "pela planilha antiga" : `em ${App.fmt.data(m.email_gerado_em.slice(0, 10))} às ${m.email_gerado_em.slice(11, 16)}`) : "";
  App.modal(el("div", { class: "modal--largo" }, el("h3", {}, novo ? "Nova medição" : `Editar medição ${m.numero_medicao || ""} · NF ${m.numero_documento || ""}`),
    ultimoEnvio ? el("p", { class: "ajuda", style: { marginTop: 0 } }, `E-mail enviado ${ultimoEnvio}.`) : null,
    App.progressoForm([
      { rotulo: "nº da NF", ok: () => !!numDoc.value.trim() },
      { rotulo: modo === "pedido" ? "pedido" : "contrato ou pedido", ok: () => (modo === "contrato" ? !!contrato.value : !!pedidoInp.value.trim()) },
      { rotulo: "emissão", ok: () => !!emissao.value },
      { rotulo: "valor", ok: () => !!valor.value },
    ]),
    el("div", { class: "grade-form" },
      el("label", { class: "campo" }, el("span", {}, "Nº da medição"), numMed),
      el("label", { class: "campo" }, el("span", {}, "Nº do documento (NF)"), numDoc),
      el("label", { class: "campo" }, el("span", {}, "Status"), status),
      el("div", { class: "campo campo--largo" }, el("span", {}, "A NF é de"), el("div", { class: "chips" }, chips)),
      campoContrato, campoPedido,
      el("label", { class: "campo" }, el("span", {}, "Data de emissão"), emissao),
      el("label", { class: "campo" }, el("span", {}, "Data de vencimento"), venc),
      el("label", { class: "campo" }, el("span", {}, "Data da medição"), medicao),
      el("label", { class: "campo" }, el("span", {}, "Valor da NF (R$)"), valor),
      el("div", { class: "campo", style: { gridColumn: "span 2" } }, infoSla),
      cb ? cb.bloco : null, notaBudgetPedido, rateioPedBox,
      el("label", { class: "campo campo--largo" }, el("span", {}, "Anexo da NF"), arquivo, anexoAtual ? el("div", { class: "ajuda" }, "Atual: ", anexoAtual, " (escolha outro arquivo para trocar)") : null),
      el("label", { class: "campo campo--largo" }, el("span", {}, "Observação"), obs)),
    msg,
    el("div", { class: "linha-acoes" },
      el("button", { class: "btn", onclick: () => enviar(false) }, "Salvar"),
      el("button", { class: "btn btn--sec", onclick: () => enviar(true), title: "Salva e gera o e-mail com a NF anexada" }, m.email_gerado_em ? "Salvar e reenviar e-mail" : "Salvar e enviar e-mail"),
      el("button", { class: "btn btn--linha", "data-fechar": "" }, "Cancelar"),
      novo ? null : el("button", { class: "btn btn--perigo", style: { marginLeft: "auto" }, onclick: async () => {
        if (!(await App.confirmar("Excluir medição", `Excluir a medição ${m.numero_medicao} (NF ${m.numero_documento})? Se ela só foi cancelada, prefira mudar o status para “Cancelada”.`, "Excluir"))) return;
        await App.api(`/api/nf/medicoes/${m.id}`, { method: "DELETE" }); App.toast("Medição excluída."); App.rotear();
      } }, "Excluir"))));
  mostrarModo();
}

/* ------------------------------------------------------------------ CONTRATOS */
function nfContratos(corpo) {
  const B = App.nf.base;
  App.exportarExcel = { rotulo: "Contratos (saldos e medições)", url: "/api/nf/exportar?tipo=contratos" };
  let filtro = "ativos";
  try { filtro = sessionStorage.getItem("nf_contr_filtro") || "ativos"; } catch (e) { /* ok */ }
  const busca = el("input", { type: "search", placeholder: "Contrato ou fornecedor…" });
  // filtro comum: vigência que cruza o período, centro de custo e projeto das linhas / classe padrão do contrato
  // medições do contrato que caem no período do filtro (pela data escolhida: medição, emissão ou vencimento)
  const medPer = (c) => (c.medicoes || []).filter(([dm, de, dv]) => App.nf.noPeriodo(App.nf.dataRef(dm, de, dv)));
  const passaFc = (c) => {
    const f = App.nf.fc;
    const vigente = !(f.de && c.data_fim && c.data_fim < f.de) && !(f.ate && c.data_inicio && c.data_inicio > f.ate);
    if (!vigente && !(App.nf.temPeriodo() && medPer(c).length)) return false;
    if (f.cc && !(c.ccs || []).includes(f.cc)) return false;
    if (f.projeto && !(c.projetos || []).includes(f.projeto)) return false;
    return true;
  };
  const filtros = {
    ativos: ["Ativos", (c) => !c.finalizado],
    saldo: [`Saldo acabando (${B.alertas.saldo.length})`, (c) => B.alertas.saldo.includes(c.id)],
    vencimento: [`Vencendo (${B.alertas.vencimento.length})`, (c) => B.alertas.vencimento.includes(c.id)],
    finalizados: ["Finalizados", (c) => !!c.finalizado],
    todos: ["Todos", () => true],
  };
  if (!filtros[filtro]) filtro = "ativos";
  const chips = Object.entries(filtros).map(([k, [rot]]) => {
    const b = el("button", { class: "chip", "aria-pressed": String(filtro === k) }, rot);
    b.onclick = () => { filtro = k; try { sessionStorage.setItem("nf_contr_filtro", k); } catch (e) { /* ok */ } chips.forEach((x) => x.setAttribute("aria-pressed", String(x === b))); desenhar(); };
    return b;
  });
  let tb; busca.oninput = () => { clearTimeout(tb); tb = setTimeout(desenhar, 150); };
  const C = B.config;
  const kpis = el("div");
  App.acoesCabecalho(App.nf.botaoImportar(), el("button", { class: "btn", onclick: () => nfEditarContrato({}) }, "+ Novo contrato"));
  corpo.append(
    nfFaixaAlertas() || "",
    App.barraPadrao({ campos: [...App.nf.camposFiltro(() => desenhar(), { rotuloData: "Período (vigência ou medições)", comBase: true }),
      el("div", { class: "campo" }, el("span", {}, "Mostrar"), el("div", { class: "chips" }, chips))], busca,
      limpar: () => { App.nf.limparFc(); busca.value = ""; try { sessionStorage.setItem("nf_contr_filtro", "ativos"); } catch (e) { /* ok */ } App.rotear(); } }),
    kpis);
  const alvo = el("div");
  corpo.append(alvo);
  function desenhar() {
    App.limpar(alvo);
    const q = App.norm(busca.value);
    const noFc = B.contratos.filter(passaFc);
    const per = App.nf.temPeriodo();
    const rotPer = `${App.fmt.dataCurta(App.nf.fc.de) || "início"} a ${App.fmt.dataCurta(App.nf.fc.ate) || "hoje"}`;
    const ativos = noFc.filter((c) => !c.finalizado);
    const nAlerta = new Set([...B.alertas.saldo, ...B.alertas.vencimento].filter((id) => noFc.some((c) => c.id === id))).size;
    App.limpar(kpis).append(el("div", { class: "kpis" },
      App.kpi("Contratos ativos", App.fmt.num(ativos.length), "core", `${noFc.length - ativos.length} finalizado(s)`),
      App.kpi("Contratado + aditivo", App.fmt.brlCurto(App.soma(ativos, (c) => c.total_contratado)), "p900", "contratos ativos"),
      per ? App.kpi("Medido no período", App.fmt.brlCurto(App.soma(noFc, (c) => App.soma(medPer(c), (x) => x[3]))), "p100", `${App.fmt.num(App.soma(noFc, (c) => medPer(c).length))} medição(ões) · ${rotPer}`)
        : App.kpi("Medições (utilizado)", App.fmt.brlCurto(App.soma(ativos, (c) => c.total_utilizado)), "p100", "soma das NFs lançadas em Medições, sem as canceladas"),
      App.kpi("Saldo atual", App.fmt.brlCurto(App.soma(ativos, (c) => c.saldo_atual)), "g200", "(contratado + aditivo) − medições"),
      App.kpi("Com alerta", App.fmt.num(nAlerta), nAlerta ? "p100" : "branco", `saldo ≤ ${C.alerta_saldo_pct}% · vence em ≤ ${C.alerta_vencimento_dias} dias`)));
    const lista = noFc.filter((c) => filtros[filtro][1](c) && (!q || App.norm(`${c.numero} ${c.fornecedor}`).includes(q)));
    alvo.append(App.cartao("Contratos", `${lista.length} contrato(s) · clique para editar ou finalizar`,
      App.tabela([
        { rotulo: "Contrato", valor: (c) => +c.numero || c.numero, render: (c) => el("div", { class: "celula-2l" }, el("b", {}, c.numero), c.n_itens ? el("small", {}, `${c.n_itens} item(ns)`) : null) },
        { rotulo: "Fornecedor", valor: (c) => c.fornecedor },
        { rotulo: "Vigência", valor: (c) => c.data_fim, render: (c) => el("div", { class: "celula-2l" },
          el("span", {}, el("span", { style: { whiteSpace: "nowrap" } }, `${App.fmt.dataCurta(c.data_inicio) || "—"} →`), " ", el("span", { style: { whiteSpace: "nowrap" } }, App.fmt.dataCurta(c.data_fim) || "—")),
          !c.finalizado && c.dias_para_vencer !== null ? el("small", { style: { color: c.dias_para_vencer < 0 ? "var(--perigo)" : c.alertas.includes("vencendo") ? "#B54708" : "" } },
            c.dias_para_vencer < 0 ? `venceu há ${-c.dias_para_vencer} dias` : `vence em ${c.dias_para_vencer} dias`) : null) },
        { rotulo: "Saldo contratado", oculta: true, ajuda: "Valor original do contrato, sem os aditivos.", num: true, valor: (c) => c.saldo_contratado, render: (c) => App.fmt.brl(c.saldo_contratado) },
        { rotulo: "Aditivo", oculta: true, ajuda: "Soma dos aditivos do contrato (valor acrescentado depois da assinatura).", num: true, valor: (c) => c.aditivo, render: (c) => c.aditivo ? App.fmt.brl(c.aditivo) : "—" },
        { rotulo: "Contratado + aditivo", ajuda: "Valor total que pode ser medido no contrato: saldo contratado + aditivos.", num: true, valor: (c) => c.total_contratado, render: (c) => el("div", { class: "celula-2l", style: { textAlign: "right" } }, el("span", {}, App.fmt.brl(c.total_contratado)), el("small", {}, c.aditivo ? `aditivo ${App.fmt.brl(c.aditivo)}` : "sem aditivo")), total: (l) => App.fmt.brl(App.soma(l, (c) => c.total_contratado)) },
        per ? { rotulo: "Medido no período", ajuda: "Soma das NFs deste contrato medidas dentro do período do filtro (sem canceladas).", num: true, valor: (c) => App.soma(medPer(c), (x) => x[3]), render: (c) => { const mp = medPer(c); return el("div", { class: "celula-2l", style: { textAlign: "right" } },
          el("span", {}, App.fmt.brl(App.soma(mp, (x) => x[3]))), el("small", {}, `${mp.length} medição(ões) no período`)); }, total: (l) => App.fmt.brl(App.soma(l, (c) => App.soma(medPer(c), (x) => x[3]))) } : null,
        { rotulo: per ? "Medições (todas)" : "Medições", ajuda: "Soma de todas as NFs lançadas neste contrato em Medições, desde o início (sem canceladas). É o valor já utilizado do contrato.", num: true, valor: (c) => c.total_utilizado, render: (c) => el("div", { class: "celula-2l", style: { textAlign: "right" } },
          el("span", {}, "− " + App.fmt.brl(c.total_utilizado)), el("small", {}, `${c.n_medicoes} medição(ões)`)), total: (l) => App.fmt.brl(App.soma(l, (c) => c.total_utilizado)) },
        { rotulo: "Saldo atual", ajuda: "Quanto ainda pode ser medido: (contratado + aditivo) − medições. Negativo = o contrato estourou.", num: true, valor: (c) => c.saldo_atual, render: (c) => el("b", { style: { color: c.saldo_atual < 0 || c.alertas.includes("saldo_acabando") ? "var(--perigo)" : "" } }, App.fmt.brl(c.saldo_atual)), total: (l) => App.fmt.brl(App.soma(l, (c) => c.saldo_atual)) },
        { rotulo: "% usado", ajuda: "Medições ÷ (contratado + aditivo). 100% = contrato todo usado.", num: true, valor: (c) => c.pct_utilizado ?? -1, render: (c) => c.pct_utilizado === null ? "—" : el("div", { class: "barra-pct", title: `${App.fmt.pct(c.pct_saldo)} de saldo` },
          el("b", { class: "trilho" }, el("i", { style: { width: Math.min(100, c.pct_utilizado) + "%", background: c.alertas.some((a) => a.startsWith("saldo")) ? NF_CORES.sem : c.pct_utilizado >= 70 ? NF_CORES.atraso : NF_CORES.prazo } })), el("span", {}, App.fmt.pct(c.pct_utilizado))) },
        { rotulo: "Alertas", ajuda: "Saldo abaixo do limite ou vigência perto do fim (limites em Prazos e alertas → Alertas dos contratos).", valor: (c) => c.alertas.length, render: (c) => nfAlertasContrato(c) || (c.finalizado ? el("span", { class: "etiqueta" }, "Finalizado") : el("span", { class: "etiqueta etiqueta--ok" }, "OK")) },
      ], lista, { onClick: nfEditarContrato, rodape: true, ordem: { i: 1, dir: 1 }, vazio: "Nenhum contrato neste filtro." })));
  }
  desenhar();
}

async function nfEditarContrato(c) {
  const B = App.nf.base;
  const cb = await nfBudgetContrato(c);
  const novo = !c.id;
  const inp = (tipo, v, extra = {}) => el("input", { type: tipo, value: v ?? "", ...extra });
  const numero = inp("text", c.numero, { placeholder: "nº do contrato" });
  const lista = el("datalist", { id: "nf-fornecedores" }, [...new Set(B.contratos.map((x) => x.fornecedor))].sort().map((f) => el("option", { value: f })));
  const forn = inp("text", c.fornecedor, { list: "nf-fornecedores", placeholder: "razão social" });
  const ini = inp("date", c.data_inicio), fim = inp("date", c.data_fim);
  const saldo = inp("number", c.saldo_contratado, { step: "0.01", min: "0" }), aditivo = inp("number", c.aditivo || "", { step: "0.01", placeholder: "0,00" });
  const fin = el("input", { type: "checkbox", checked: !!c.finalizado });
  const obs = el("textarea", { rows: 2 }, c.observacao || "");
  const resumo = el("div", { class: "resumo-contrato" });
  const atualizarResumo = () => {
    const total = (+saldo.value || 0) + (+aditivo.value || 0), usado = c.total_utilizado || 0;
    App.limpar(resumo).append(
      el("span", {}, "Contratado + aditivo: ", el("b", {}, App.fmt.brl(total))),
      el("span", {}, "Medições: ", el("b", {}, "− " + App.fmt.brl(usado)), ` (${c.n_medicoes || 0})`),
      el("span", {}, "Saldo atual: ", el("b", { style: { color: total - usado < 0 ? "var(--perigo)" : "" } }, App.fmt.brl(total - usado))),
      c.n_medicoes ? el("a", { href: "#/nf/medicoes", "data-fechar": "", onclick: () => { try { sessionStorage.setItem("nf_filtro_med", JSON.stringify({ q: c.numero })); } catch (e) { /* ok */ } } }, "ver medições →") : null);
  };
  [saldo, aditivo].forEach((x) => x.addEventListener("input", atualizarResumo));
  atualizarResumo();
  const msg = el("p", { class: "ajuda", style: { color: "var(--perigo)", minHeight: "18px" } });
  App.modal(el("div", { class: "modal--largo" }, el("h3", {}, novo ? "Novo contrato" : `Contrato ${c.numero}`), lista,
    App.progressoForm([{ rotulo: "nº do contrato", ok: () => !!numero.value.trim() }, { rotulo: "fornecedor", ok: () => !!forn.value.trim() }]),
    novo ? null : nfAlertasContrato(c),
    el("div", { class: "grade-form" },
      el("label", { class: "campo" }, el("span", {}, "Nº do contrato"), numero),
      el("label", { class: "campo", style: { gridColumn: "span 2" } }, el("span", {}, "Fornecedor"), forn),
      el("label", { class: "campo" }, el("span", {}, "Data de início"), ini),
      el("label", { class: "campo" }, el("span", {}, "Data final"), fim),
      el("div", {}),
      el("label", { class: "campo" }, el("span", {}, "Saldo contratado (R$)"), saldo),
      el("label", { class: "campo" }, el("span", {}, "Aditivo (R$) — se houver"), aditivo),
      el("div", {}),
      cb ? cb.bloco : null,
      el("label", { class: "campo campo--largo" }, el("span", {}, "Observação"), obs),
      el("label", { class: "campo campo--largo", style: { flexDirection: "row", alignItems: "center", gap: "8px" } }, fin, "Contrato finalizado (sai da lista de ativos, dos alertas e da escolha nas medições)")),
    resumo, msg,
    el("div", { class: "linha-acoes" },
      el("button", { class: "btn", onclick: async () => {
        try {
          const erroItens = cb && cb.validar();
          if (erroItens) { msg.textContent = erroItens; return; }
          const rc = await App.api("/api/nf/contratos", { method: "POST", json: { id: c.id, numero: numero.value, fornecedor: forn.value, data_inicio: ini.value, data_fim: fim.value,
            saldo_contratado: saldo.value, aditivo: aditivo.value, finalizado: fin.checked, observacao: obs.value } });
          const rb = await nfSalvarBudget(cb, rc.id || c.id);
          const n = rb && rb.medicoes_atualizadas;
          App.fecharModal(); App.toast(n ? `Contrato salvo · ${n} medição(ões) do contrato atualizadas com a classe dele.` : "Contrato salvo."); App.rotear();
        } catch (e) { msg.textContent = e.message; }
      } }, "Salvar"),
      el("button", { class: "btn btn--linha", "data-fechar": "" }, "Cancelar"),
      novo || c.n_medicoes ? null : el("button", { class: "btn btn--perigo", style: { marginLeft: "auto" }, onclick: async () => {
        if (!(await App.confirmar("Excluir contrato", `Excluir o contrato ${c.numero}?`, "Excluir"))) return;
        try { await App.api(`/api/nf/contratos/${c.id}`, { method: "DELETE" }); App.toast("Contrato excluído."); App.rotear(); } catch (e) { App.toast(e.message, true); }
      } }, "Excluir"))));
}

/* ------------------------------------------------------------------ GRÁFICOS */
async function nfGraficos(corpo) {
  App.exportarExcel = { rotulo: "Notas fiscais (medições, contratos, prazos)", url: "/api/nf/exportar?tipo=tudo" };
  let forn = "";
  try { forn = sessionStorage.getItem("nf_g_forn") || ""; } catch (e) { /* ok */ }
  const primeira = await App.api("/api/nf/graficos");
  const selForn = el("select", {}, el("option", { value: "" }, "Todos"), primeira.fornecedores.map((f) => el("option", { value: f, selected: f === forn }, f)));
  const mudar = () => { forn = selForn.value; try { sessionStorage.setItem("nf_g_forn", forn); } catch (e) { /* ok */ } desenhar(); };
  selForn.onchange = mudar;
  corpo.append(App.barraPadrao({ campos: [...App.nf.camposFiltro(() => desenhar(), { rotuloData: "Período", comBase: true }),
    el("label", { class: "campo campo--cresce" }, el("span", {}, "Fornecedor"), selForn)],
    limpar: () => { App.nf.limparFc(); try { sessionStorage.setItem("nf_g_forn", ""); } catch (e) { /* ok */ } App.rotear(); } }));
  const alvo = el("div");
  corpo.append(alvo);

  async function desenhar() {
    const d = await App.api("/api/nf/graficos?" + new URLSearchParams({ ...App.nf.fcParams(), fornecedor: forn }));
    App.destruirGraficos();
    App.limpar(alvo);
    const t = d.totais, sla = d.sla_dias;
    if (!t.n) { alvo.append(el("div", { class: "cartao vazio" }, "Nenhuma medição para os filtros escolhidos.")); return; }
    const comSla = t.no_prazo + t.atrasada;
    const fornOk = d.fornecedores_prazo.filter((x) => !x.fora).length;
    alvo.append(el("div", { class: "kpis" },
      App.kpi("NFs medidas", App.fmt.num(t.n), "core", App.nf.fc.de || App.nf.fc.ate ? `de ${App.fmt.dataCurta(App.nf.fc.de) || "início"} a ${App.fmt.dataCurta(App.nf.fc.ate) || "hoje"}` : "todo o período"),
      App.kpi("Valor total medido", App.fmt.brlCurto(t.valor), "p900", `média ${App.fmt.brlCurto(t.valor / t.n)} por NF`),
      App.kpi(`SLA ${sla} dias úteis`, App.fmt.pct(comSla ? 100 * t.no_prazo / comSla : null), "g200", `${t.no_prazo} no prazo · ${t.atrasada} atrasada(s)`),
      App.kpi("Atrasadas com observação", App.fmt.pct(t.atrasada ? 100 * t.com / t.atrasada : null), "p100", `${t.com} com · ${t.sem} sem observação`),
      App.kpi("Fornecedores sempre no prazo", `${fornOk} de ${d.fornecedores_prazo.length}`, "branco", "mandaram todas as NFs até a data limite")));

    const meses = d.por_mes;
    const nomeMes = (k) => { const [a, mm] = k.split("-"); return ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"][+mm - 1] + "/" + a.slice(2); };
    const g1 = G.area("grafico"), g2 = G.area("grafico");
    alvo.append(el("div", { class: "grade g-12" },
      el("div", { class: "s-6" }, App.cartao("NFs medidas por mês", `quantidade · cor = SLA de ${sla} dias úteis (emissão → medição)`,
        G.legenda([[`No prazo (até ${sla} d.u.)`, NF_CORES.prazo], [`Atrasada (> ${sla} d.u.)`, NF_CORES.atraso], ["Sem data", "#CBC3D6"]]), el("div", { style: { height: "8px" } }), g1.div)),
      el("div", { class: "s-6" }, App.cartao("Valor medido por mês", "soma das NFs (sem as canceladas)", g2.div))));
    const rot = meses.length > 12 ? 45 : 0;
    G.barrasEmpilhadas(g1.canvas, meses.map((x) => nomeMes(x.mes)), [
      { rotulo: "No prazo", cor: NF_CORES.prazo, valores: meses.map((x) => x.no_prazo || 0) },
      { rotulo: "Atrasada", cor: NF_CORES.atraso, valores: meses.map((x) => x.atrasada || 0) },
      { rotulo: "Sem data", cor: "#CBC3D6", valores: meses.map((x) => x.sem_data || 0) },
    ], { fmt: (v) => App.fmt.num(v), rotacao: rot });
    G.barrasEmpilhadas(g2.canvas, meses.map((x) => nomeMes(x.mes)), [{ rotulo: "Valor medido", cor: App.cores.core, valores: meses.map((x) => x.valor || 0) }], { rotacao: rot });

    const g3 = G.area("grafico"), g4 = G.area("grafico");
    g3.div.style.height = g4.div.style.height = "170px";
    alvo.append(el("div", { class: "grade g-12", style: { marginTop: "16px" } },
      el("div", { class: "s-6" }, App.cartao(`Status do SLA de ${sla} dias úteis`, "da data de emissão até a data da medição", g3.div)),
      el("div", { class: "s-6" }, App.cartao("Medições atrasadas: tiveram observação?", `${t.atrasada} medição(ões) depois de ${sla} dias úteis`, g4.div))));
    const pct = (v, tot) => (tot ? ` (${App.fmt.pct(100 * v / tot)})` : "");
    G.barrasH(g3.canvas, ["No prazo", "Atrasada"], [t.no_prazo, t.atrasada], [NF_CORES.prazo, NF_CORES.atraso], { fmt: (v) => App.fmt.num(v), tooltipExtra: (i) => pct([t.no_prazo, t.atrasada][i], comSla) });
    G.barrasH(g4.canvas, ["Com observação", "Sem observação"], [t.com, t.sem], [NF_CORES.com, NF_CORES.sem], { fmt: (v) => App.fmt.num(v), tooltipExtra: (i) => pct([t.com, t.sem][i], t.atrasada) });

    const pf = d.fornecedores_prazo;
    const g5 = G.area("grafico");
    const rotPf = pf.map((x) => App.quebrar(x.f, 40));
    g5.div.style.height = Math.max(180, App.soma(rotPf, (r) => Math.max(32, (Array.isArray(r) ? r.length : 1) * 19 + 10)) + 50) + "px";
    alvo.append(el("div", { class: "grade", style: { marginTop: "16px" } },
      App.cartao("Fornecedores: NFs dentro do prazo de recebimento", "NF emitida até a data limite do mês (Prazos e feriados)" + (t.sem_prazo ? ` · ${t.sem_prazo} NF(s) de meses sem prazo cadastrado ficaram de fora` : ""),
        G.legenda([["Dentro do prazo", NF_CORES.prazo], ["Fora do prazo", NF_CORES.sem]]), el("div", { style: { height: "8px" } }), g5.div)));
    if (pf.length) {
      G.barrasHEmpilhadas(g5.canvas, rotPf, [
        { rotulo: "Dentro do prazo", cor: NF_CORES.prazo, valores: pf.map((x) => x.ok) },
        { rotulo: "Fora do prazo", cor: NF_CORES.sem, valores: pf.map((x) => x.fora) },
      ], { fmt: (v) => App.fmt.num(v) });
    }
  }
  await desenhar();
}

/* ------------------------------------------------------------------ PRAZOS E FERIADOS */
async function nfPrazos(corpo) {
  App.exportarExcel = { rotulo: "Notas fiscais (medições, contratos, prazos)", url: "/api/nf/exportar?tipo=tudo" };
  const B = App.nf.base;
  // filtro comum: o período escolhe os meses e feriados; centro de custo e projeto contam as NFs de cada mês
  corpo.append(App.barraPadrao({ campos: App.nf.camposFiltro(() => App.rotear(), { rotuloData: "Período" }), limpar: () => { App.nf.limparFc(); App.rotear(); } }));
  const fc = App.nf.fc;
  let pm = {};
  try { pm = (await App.api("/api/nf/graficos?" + new URLSearchParams({ ...App.nf.fcParams(), de: "", ate: "" }))).prazo_mes || {}; } catch (e) { /* ok */ }
  const noPeriodo = (iso) => (!fc.de || iso >= fc.de.slice(0, iso.length)) && (!fc.ate || iso <= fc.ate.slice(0, iso.length));
  const prazos = B.prazos.filter((p) => noPeriodo(p.mes));
  const feriados = B.feriados.filter((f) => noPeriodo(f.data));
  const rotNfs = fc.cc || fc.projeto ? `NFs no prazo (${[fc.cc && "CC " + fc.cc, fc.projeto && "projeto " + fc.projeto].filter(Boolean).join(" · ")})` : "NFs no prazo";
  const mes = el("input", { type: "month" }), prazo = el("input", { type: "date" });
  const dataF = el("input", { type: "date" }), descF = el("input", { type: "text", placeholder: "ex.: Tiradentes" });
  const nomeMes = (k) => { const [a, mm] = k.split("-"); return ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"][+mm - 1] + " de " + a; };
  corpo.append(el("div", { class: "grade g-12" },
    el("div", { class: "s-7" }, App.cartao("Prazos de recebimento das NFs", "data limite para os fornecedores mandarem as notas de cada mês",
      el("div", { class: "linha-acoes", style: { marginTop: 0, marginBottom: "12px", alignItems: "flex-end" } },
        el("label", { class: "campo" }, el("span", {}, "Mês"), mes),
        el("label", { class: "campo" }, el("span", {}, "Data limite"), prazo),
        el("button", { class: "btn", onclick: async () => {
          try { await App.api("/api/nf/prazos", { method: "POST", json: { mes: mes.value, prazo: prazo.value } }); App.toast("Prazo salvo."); App.rotear(); } catch (e) { App.toast(e.message, true); }
        } }, "Salvar prazo")),
      App.tabela([
        { rotulo: "Mês", valor: (p) => p.mes, render: (p) => el("b", {}, nomeMes(p.mes)) },
        { rotulo: "Data limite", valor: (p) => p.prazo, render: (p) => App.fmt.data(p.prazo) },
        { rotulo: rotNfs, num: true, valor: (p) => (pm[p.mes] || {}).n || 0, render: (p) => {
          const x = pm[p.mes];
          if (!x || !x.n) return el("span", { class: "ajuda" }, "—");
          const ok = x.ok || 0;
          return el("span", { class: "etiqueta " + (ok === x.n ? "etiqueta--ok" : "etiqueta--aviso"), title: `${ok} de ${x.n} NF(s) emitidas até a data limite` }, `${ok} de ${x.n}`);
        } },
        { rotulo: "E-mail aos fornecedores", valor: (p) => p.email_gerado_em, render: (p) => p.email_gerado_em ? el("span", { class: "etiqueta etiqueta--ok" }, p.email_gerado_em === "planilha" ? "Enviado (planilha)" : "Gerado em " + App.fmt.data(p.email_gerado_em.slice(0, 10))) : el("span", { class: "etiqueta" }, "Não gerado") },
        { rotulo: "", render: (p) => el("span", { class: "acoes-linha" },
          el("button", { class: "btn btn--mini " + (p.email_gerado_em ? "btn--linha" : "btn--sec"), onclick: async () => { if (await App.nf.baixarEmail(`/api/nf/prazos/${p.mes}/email`)) App.rotear(); } }, p.email_gerado_em ? "Reenviar" : "Enviar e-mail"),
          el("button", { class: "btn btn--mini btn--linha", title: "Excluir", onclick: async () => {
            if (!(await App.confirmar("Excluir prazo", `Excluir o prazo de ${nomeMes(p.mes)}?`, "Excluir"))) return;
            await App.api(`/api/nf/prazos/${p.mes}`, { method: "DELETE" }); App.rotear();
          } }, "✕")) },
      ], prazos, { vazio: "Nenhum prazo no período." }))),
    el("div", { class: "s-5" }, App.cartao("Feriados", "não contam como dia útil no SLA",
      el("div", { class: "linha-acoes", style: { marginTop: 0, marginBottom: "12px", alignItems: "flex-end" } },
        el("label", { class: "campo" }, el("span", {}, "Data"), dataF),
        el("label", { class: "campo campo--cresce" }, el("span", {}, "Descrição"), descF),
        el("button", { class: "btn", onclick: async () => {
          try { await App.api("/api/nf/feriados", { method: "POST", json: { data: dataF.value, descricao: descF.value } }); App.toast("Feriado salvo (dias úteis recalculados)."); App.rotear(); } catch (e) { App.toast(e.message, true); }
        } }, "Adicionar")),
      App.tabela([
        { rotulo: "Data", valor: (f) => f.data, render: (f) => App.fmt.data(f.data) },
        { rotulo: "Descrição", valor: (f) => f.descricao, render: (f) => f.descricao || "—" },
        { rotulo: "", render: (f) => el("button", { class: "btn btn--mini btn--linha", title: "Excluir", onclick: async () => {
          if (!(await App.confirmar("Excluir feriado", `Excluir o feriado de ${App.fmt.data(f.data)}?`, "Excluir"))) return;
          await App.api(`/api/nf/feriados/${f.data}`, { method: "DELETE" }); App.rotear();
        } }, "✕") },
      ], feriados, { ordem: { i: 0, dir: -1 }, vazio: "Nenhum feriado no período." })))));
}

/* ------------------------------------------------------------------ CONFIGURAÇÕES */
function nfConfig(corpo) {
  const C = App.nf.base.config;
  const campos = {};
  const num = (k, extra = {}) => (campos[k] = el("input", { type: "number", min: "0", step: "1", value: C[k], ...extra }));
  const txt = (k, ph) => (campos[k] = el("textarea", { rows: 2, placeholder: ph }, C[k] || ""));
  const campo = (rot, input, ajuda) => el("label", { class: "campo" }, el("span", {}, rot), input, ajuda ? el("small", {}, ajuda) : null);
  const salvar = async () => {
    const d = Object.fromEntries(Object.entries(campos).map(([k, x]) => [k, x.value]));
    try { await App.api("/api/nf/config", { method: "POST", json: d }); App.toast("Configurações salvas."); await App.nf.carregarBase(); } catch (e) { App.toast(e.message, true); }
  };
  corpo.append(
    el("div", { class: "config-grade" },
      App.cartao("Alertas dos contratos", "aparecem em Contratos, em Medições e no menu",
        el("div", { class: "config-campos" },
          campo("Saldo acabando: avisar quando o saldo atual ficar em até (%)", num("alerta_saldo_pct", { max: "100" }), "porcentagem do total (contratado + aditivo). Ex.: 10 = avisa quando sobrar 10% ou menos"),
          campo("… ou quando o saldo atual ficar em até (R$)", num("alerta_saldo_valor", { step: "0.01" }), "0 = não usar este limite"),
          campo("Vencimento: avisar quando faltarem até (dias)", num("alerta_vencimento_dias"), "dias até a data final do contrato"))),
      App.cartao("Prazos das medições", "usados no SLA e no e-mail ao fiscal",
        el("div", { class: "config-campos" },
          campo("SLA: dias úteis entre a emissão e a medição", num("sla_dias_uteis"), "acima disso a medição conta como atrasada"),
          campo("Liberar para o financeiro: dias antes do vencimento", num("dias_liberacao"), "o e-mail diz “liberar até” = vencimento − este número de dias")))),
    el("div", { class: "config-grade", style: { marginTop: "16px" } },
      App.cartao("E-mail da NF (interno, para o fiscal)", "separe os endereços com ponto e vírgula ( ; )",
        el("div", { class: "config-campos" },
          campo("Para", txt("email_nf_para", "fiscal@empresa.com.br; ...")),
          campo("Cc", txt("email_nf_cc", "")),
          campo("Cco", txt("email_nf_cco", "")))),
      App.cartao("E-mail para fornecedores (solicitar NFs)", "dica: use Cco para os fornecedores não verem os endereços uns dos outros",
        el("div", { class: "config-campos" },
          campo("Para", txt("email_forn_para", "")),
          campo("Cc", txt("email_forn_cc", "")),
          campo("Cco", txt("email_forn_cco", "fornecedor1@...; fornecedor2@..."), "um grupo do Outlook (ex.: “Fornecedores”) também funciona: o Outlook resolve o nome ao enviar")))),
    el("div", { class: "linha-acoes", style: { marginTop: "16px" } }, el("button", { class: "btn", onclick: salvar }, "Salvar configurações")),
    el("div", { class: "grade", style: { marginTop: "24px" } }, App.cartao("Importar planilha antiga", "EnviarEmailNF.xlsm: contratos, medições, prazos e feriados",
      el("p", { class: "ajuda", style: { marginTop: 0 } }, "Também fica em Medições (botão “Importar planilha” ou arrastando o arquivo na página). Entram medições novas e campos que estavam vazios; nada é duplicado nem sobrescrito."),
      App.nf.botaoImportar("Escolher a planilha"))));
}
