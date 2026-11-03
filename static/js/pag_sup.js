/* Área: Suprimentos — rateio mensal das contas de energia elétrica, água e gás.
   Contas das concessionárias + linhas de rateio por centro de custo / projeto. A Parte da Engenharia é
   o que sobra (total das contas − repassado). Desconto em % por linha: a parte descontada volta para a Engenharia. */
"use strict";

App.sup = { base: null };
const SUP_U = [["energia", "Energia elétrica", "Energia"], ["agua", "Água", "Água"], ["gas", "Gás", "Gás"]];
const SUP_CORES = { energia: "#6A0BB0", agua: "#2E7DB5", gas: "#E08A1E", poco: "#7FB8E0", eng: "#4F8F33" };
// medidores dos relatórios: as 3 contas + poço artesiano (água de poço, à parte da conta da Sabesp)
const SUP_M = [...SUP_U, ["poco", "Poço artesiano", "Poço"]];
const supMesNome = (m) => (m ? `${MESES_LONGOS[+m.slice(5, 7) - 1]} de ${m.slice(0, 4)}` : "");
const supMesCurto = (m) => `${MESES_CURTOS[+m.slice(5, 7) - 1]}/${m.slice(2, 4)}`;

App.sup.carregar = async (ano) => (App.sup.base = await App.api("/api/sup/base" + (ano ? `?ano=${ano}` : "")));
App.sup.rotCc = (c) => { const x = (App.sup.base.centros || []).find((y) => y.nome === c); return c ? (x && x.descricao ? `${c} — ${x.descricao}` : c) : ""; };
App.sup.rotPj = (p) => { const x = (App.sup.base.projetos || []).find((y) => y.nome === p); return p ? (x && x.descricao ? `${p} — ${x.descricao}` : p) : ""; };

App.paginas.sup = async function (raiz, params) {
  const sub = ["resumo", "config"].includes(params[0]) ? params[0] : "mes";
  try { await App.sup.carregar(); } catch (e) { raiz.append(el("div", { class: "cartao vazio" }, e.message)); return; }
  const titulos = {
    mes: ["Rateio do mês", "Contas de energia elétrica, água, gás e poço artesiano do mês e quanto cada centro de custo / projeto paga. O que não é repassado é a Parte da Engenharia."],
    resumo: ["Resumo por mês", "Evolução das contas, do que foi cobrado de cada área e da Parte da Engenharia"],
    config: ["Configurações", "Centro de custo / projeto da Engenharia e códigos usados na planilha de importação do Suprimentos"],
  }[sub];
  const acoes = sub === "config" ? [] : [...supBotoesExcel(), el("button", { class: "btn", onclick: supNovoMes }, "+ Novo mês")];
  raiz.append(el("div", { class: "pagina-cabecalho" }, el("div", {}, el("h2", {}, titulos[0]), el("p", {}, titulos[1])), el("div", { class: "acoes" }, ...acoes)));
  const corpo = el("div");
  raiz.append(corpo);
  if (sub === "mes") await supMes(corpo, params[1]);
  else if (sub === "resumo") await supResumo(corpo);
  else supConfig(corpo);
};

/* ------------------------------------------------------------------ importar / modelo */
function supBotoesExcel() {
  const inp = el("input", { type: "file", accept: ".xlsx,.xlsm,.xls", hidden: true });
  inp.onchange = () => { if (inp.files[0]) supImportar(inp.files[0]); inp.value = ""; };
  App.soltarNaPagina && App.soltarNaPagina(null, () => App.rotear(), { enviar: (files) => supImportar(files[0]), texto: "Planilha do requisitante ou a base exportada do site" });
  return [inp,
    App.btnEditor("Importar Excel", () => inp.click(), "btn btn--linha"),
    el("a", { class: "btn btn--linha", href: "/api/sup/modelo" }, "Baixar modelo Excel")];
}

function supImportar(arquivo) {
  const meses = App.sup.base.meses.map((m) => m.mes);
  const hoje = new Date();
  const anterior = App.iso(new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1)).slice(0, 7);
  const mes = el("input", { type: "month", value: sessionStorage.getItem("sup_mes") || meses[0] || anterior });
  const modo = el("select", {}, el("option", { value: "substituir" }, "Substituir as linhas e contas do mês"), el("option", { value: "acrescentar" }, "Acrescentar ao que já existe"));
  const msg = el("p", { class: "ajuda", style: { color: "var(--perigo)", minHeight: "18px" } });
  const enviar = el("button", { class: "btn" }, "Importar");
  enviar.onclick = async () => {
    const fd = new FormData();
    fd.append("arquivo", arquivo); fd.append("mes", mes.value); fd.append("modo", modo.value);
    enviar.disabled = true; enviar.textContent = "Importando…";
    try {
      const r = await fetch("/api/sup/importar", { method: "POST", body: fd });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.erro || `Erro ${r.status}`);
      App.modal(el("div", { class: "modal--largo" }, el("h3", {}, "Planilha importada"),
        d.tarifas !== undefined ? el("p", {}, `Base das tarifas: ${d.tarifas} conta(s) mensais de energia, água e gás (${d.meses_tarifa.length ? supMesNome(d.meses_tarifa[0]) + " a " + supMesNome(d.meses_tarifa[d.meses_tarifa.length - 1]) : "—"}).`)
          : el("p", {}, `${d.linhas} linha(s) de rateio e ${d.contas} conta(s) em ${d.meses.map(supMesNome).join(", ") || "—"}.`),
        d.avisos.length ? el("ul", { class: "lista-avisos" }, d.avisos.map((a) => el("li", {}, a))) : null,
        el("div", { class: "linha-acoes" }, el("button", { class: "btn", "data-fechar": "", onclick: () => {
          if (d.meses[0]) { try { sessionStorage.setItem("sup_mes", d.meses[0]); } catch (e) { /* ok */ } }
          location.hash = "#/sup/mes" + (d.meses[0] ? "/" + d.meses[0] : ""); App.rotear();
        } }, "Ver o mês"))));
    } catch (e) { msg.textContent = e.message; enviar.disabled = false; enviar.textContent = "Importar"; }
  };
  App.modal(el("div", {}, el("h3", {}, "Importar planilha de suprimentos"),
    el("p", { class: "ajuda", style: { marginTop: 0 } }, `Arquivo: ${arquivo.name}. Aceita a planilha do requisitante (Centro de custo | Projeto | Quantidade Energia / Água / Gás) e a base exportada pelo site (abas RATEIO e CONTAS). A linha da Engenharia não é importada: o site calcula.`),
    el("div", { class: "grade-form", style: { gridTemplateColumns: "1fr 1fr" } },
      App.campo("Mês (competência)", mes), App.campo("Se o mês já tiver dados", modo)),
    el("p", { class: "ajuda" }, "Na base exportada pelo site, o mês vem de cada linha; o mês acima só vale para a planilha do requisitante."),
    msg, el("div", { class: "linha-acoes" }, enviar, el("button", { class: "btn btn--linha", "data-fechar": "" }, "Cancelar"))));
}

function supNovoMes() {
  const meses = App.sup.base.meses.map((m) => m.mes);
  const hoje = new Date();
  const sugestao = App.iso(new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1)).slice(0, 7);
  const mes = el("input", { type: "month", value: meses.includes(sugestao) ? App.hoje().slice(0, 7) : sugestao });
  const copiar = el("select", {}, el("option", { value: "" }, "Começar vazio"), meses.map((m) => el("option", { value: m }, `Copiar as linhas de ${supMesNome(m)}`)));
  if (meses[0]) copiar.value = meses[0];
  const comValores = el("input", { type: "checkbox", style: { width: "auto", margin: 0 } });
  const comEventos = el("input", { type: "checkbox", checked: true, style: { width: "auto", margin: 0 } });
  const msg = el("p", { class: "ajuda", style: { color: "var(--perigo)", minHeight: "18px" } });
  App.modal(el("div", {}, el("h3", {}, "Novo mês"),
    el("div", { class: "grade-form", style: { gridTemplateColumns: "1fr 1.4fr" } }, App.campo("Mês (competência)", mes), App.campo("Linhas de rateio", copiar)),
    el("label", { style: { display: "flex", gap: "8px", alignItems: "center", fontSize: "16px" } }, comValores, "Copiar também os valores (senão as linhas vêm zeradas, só com centro de custo, projeto e desconto)"),
    el("label", { style: { display: "flex", gap: "8px", alignItems: "center", fontSize: "16px", marginTop: "8px" } }, comEventos,
      "Trazer os eventos do mês do Relatório de eventos, com os valores de energia, água e gás (R$) lançados lá"),
    msg,
    el("div", { class: "linha-acoes" }, el("button", { class: "btn", onclick: async () => {
      try {
        const r = await App.api("/api/sup/meses", { method: "POST", json: { mes: mes.value, copiar_de: copiar.value || null, com_valores: comValores.checked, eventos: comEventos.checked } });
        App.fecharModal();
        App.toast(`Mês criado${r.copiadas ? ` · ${r.copiadas} linha(s) copiada(s)` : ""}${r.eventos.length ? ` · ${r.eventos.length} evento(s) do Relatório` : ""}.`);
        try { sessionStorage.setItem("sup_mes", r.mes); } catch (e) { /* ok */ }
        location.hash = "#/sup/mes/" + r.mes;
      } catch (e) { msg.textContent = e.message; }
    } }, "Criar"), el("button", { class: "btn btn--linha", "data-fechar": "" }, "Cancelar"))));
}

/* ------------------------------------------------------------------ RATEIO DO MÊS */
async function supMes(corpo, mesParam) {
  const meses = App.sup.base.meses.map((m) => m.mes);
  let mes = mesParam || sessionStorage.getItem("sup_mes") || meses[0];
  if (!meses.includes(mes)) mes = meses[0];
  if (!mes) {
    corpo.append(el("div", { class: "cartao vazio" }, el("p", {}, "Nenhum mês lançado ainda."),
      el("p", { class: "ajuda" }, "Crie o mês em “+ Novo mês” ou importe a planilha do requisitante em “Importar Excel”.")));
    return;
  }
  try { sessionStorage.setItem("sup_mes", mes); } catch (e) { /* ok */ }
  App.exportarExcel = [
    { titulo: "Excel · planilha do setor", rotulo: `${supMesNome(mes)}: requisitante + Suprimentos, no mesmo arquivo-modelo`, url: `/api/sup/planilha?mes=${mes}` },
    { titulo: "Excel · base do site", rotulo: "RATEIO e CONTAS (para reimportar) + uma planilha por conta", url: `/api/sup/exportar?mes=${mes}` }];
  const selMes = el("select", {}, meses.map((m) => el("option", { value: m, selected: m === mes }, supMesNome(m))));
  selMes.onchange = () => { location.hash = "#/sup/mes/" + selMes.value; };
  const busca = el("input", { type: "search", placeholder: "Linha, centro de custo ou projeto…" });
  corpo.append(App.barraPadrao({ campos: [App.campo("Mês", selMes),
    el("div", { class: "campo" }, el("span", {}, " "), el("div", { class: "presets" },
      App.btnEditor("Excluir este mês", async () => {
        if (!(await App.confirmar("Excluir mês", `Excluir ${supMesNome(mes)} inteiro (contas e linhas de rateio)? Não dá para desfazer.`, "Excluir"))) return;
        await App.api(`/api/sup/meses/${mes}`, { method: "DELETE" }); try { sessionStorage.removeItem("sup_mes"); } catch (e) { /* ok */ }
        location.hash = "#/sup/mes"; App.rotear();
      }, "btn btn--linha btn--mini")))],
  busca, limpar: () => { busca.value = ""; desenhar(); } }));
  const alvo = el("div");
  corpo.append(alvo);
  let d;
  const sel = new Set();
  async function recarregar() { d = await App.api(`/api/sup/mes/${mes}`); desenhar(); }
  let tb; busca.oninput = () => { clearTimeout(tb); tb = setTimeout(desenhar, 150); };

  function desenhar() {
    App.destruirGraficos();
    App.limpar(alvo);
    const T = d.totais;
    const soma = (o) => o.energia + o.agua + o.gas;
    const semCod = d.linhas.filter((l) => (l.energia || l.agua || l.gas) && (!l.centro_custo || !l.projeto));
    const avisos = [...d.avisos, ...(semCod.length ? [`${semCod.length} linha(s) sem centro de custo ou projeto (nº): ${semCod.map((l) => l.descricao).join(", ")}. Abra a linha e escolha, senão a planilha do Suprimentos sai sem o código.`] : [])];
    if (avisos.length) alvo.append(el("div", { class: "alertas-nf" }, avisos.map((a) => el("div", { class: "alerta-nf alerta-nf--saldo" }, el("i", { class: "alerta-ponto" }), el("span", {}, a)))));
    const pctEng = (u) => (T.contas[u] ? ` · ${App.fmt.pct(100 * T.engenharia[u] / T.contas[u])} das contas` : "");
    alvo.append(el("div", { class: "kpis" },
      App.kpi("Total das contas", App.fmt.brlCurto(soma(T.contas)), "core", `${d.contas.length} conta(s) · ${supMesNome(mes)}`, AJ.kpiTotal),
      ...SUP_U.map(([u, , curto], i) => App.kpi(`Conta de ${curto.toLowerCase()}`, App.fmt.brlCurto(T.contas[u]), ["p900", "p100", "branco"][i],
        `Parte da Engenharia ${App.fmt.brlCurto(T.engenharia[u])}${pctEng(u)}` + (u === "agua" && !d.poco_separado && d.poco_conta_na_agua ? ` · inclui o poço ${App.fmt.brlCurto(d.poco_conta_na_agua)}` : ""),
        AJ.kpiConta(curto.toLowerCase()))),
      !d.poco_separado ? null : App.kpi("Poço artesiano", App.fmt.brlCurto(T.poco_mes ?? T.poco), "p100",
        `${(+(T.poco_mes_m3 ?? T.poco_m3) || 0).toLocaleString("pt-BR")} m³ · ${T.poco_da_conta ? "conta Poço Artesiano" : T.poco_mes !== null ? "total do mês" : "soma das linhas (sem conta do poço)"}`
        + (T.poco_engenharia !== null ? ` · Parte da Engenharia ${App.fmt.brlCurto(T.poco_engenharia)}` : ""), AJ.kpiPoco),
      App.kpi("Parte da Engenharia", App.fmt.brlCurto(soma(T.engenharia)), "g200",
        `repassado às áreas ${App.fmt.brlCurto(soma(T.repassado))}${soma(T.descontos) ? ` · descontos ${App.fmt.brlCurto(soma(T.descontos))}` : ""}`, AJ.kpiEng)));
    if (d.poco_separado && !d.contas.some((c) => c.eh_poco) && T.poco_mes === null && App.soma(d.linhas, (l) => l.poco || 0))
      alvo.append(el("div", { class: "alertas-nf" }, el("div", { class: "alerta-nf alerta-nf--saldo" }, el("i", { class: "alerta-ponto" }),
        el("span", {}, "Falta a conta do poço artesiano: lance em Contas do mês uma conta com fornecedor “Poço Artesiano” (valor da NF do poço) para calcular a Parte da Engenharia do poço."))));

    /* ---- contas */
    const nomeU = Object.fromEntries(SUP_U.map(([u, n]) => [u, n]));
    alvo.append(el("div", { class: "secao" }, el("h3", {}, "1. Contas que chegaram no mês")),
      App.cartao("Contas das concessionárias (notas do mês)", "clique numa conta para editar · pode haver mais de uma por tipo (ex.: Enel + Esfera) · o poço artesiano entra aqui como conta “Poço Artesiano”",
        el("div", { class: "linha-acoes", style: { marginTop: 0, marginBottom: "10px" } }, App.btnEditor("+ Adicionar conta", () => supEditarConta({ mes }, recarregar), "btn btn--mini")),
        App.tabela([
          { rotulo: "Conta", ajuda: AJ.colConta, valor: (c) => (c.conta_poco ? "poco" : c.utilidade), render: (c) => c.conta_poco
            ? el("span", { class: "etiqueta", style: { background: SUP_CORES.poco + "33", color: "#1F5F8B" } }, c.eh_poco ? "Poço artesiano" : "Água · poço")
            : el("span", { class: "etiqueta", style: { background: SUP_CORES[c.utilidade] + "22", color: SUP_CORES[c.utilidade] } }, nomeU[c.utilidade]) },
          { rotulo: "Fornecedor", ajuda: "Empresa que emitiu a conta (Enel, Esfera, Sabesp, Comgás) ou “Poço Artesiano”. O nome também decide o tipo: fornecedor com “poço” ou “artesiano” vira a conta do poço e **não** entra na conta de água da Sabesp.", valor: (c) => c.fornecedor, render: (c) => c.fornecedor || "—" },
          { rotulo: "Nº documento", ajuda: "Número da nota / fatura, como está no documento. Serve só para identificar a conta (e sai na planilha do Suprimentos).", valor: (c) => c.numero_doc, render: (c) => c.numero_doc || "—" },
          { rotulo: "Emissão", valor: (c) => c.data_emissao, render: (c) => App.fmt.data(c.data_emissao) || "—" },
          { rotulo: "Vencimento", ajuda: "Data de vencimento da conta. Emissão e vencimento saem na planilha de importação do Suprimentos.", valor: (c) => c.data_vencimento, render: (c) => App.fmt.data(c.data_vencimento) || "—" },
          { rotulo: "Valor da nota", ajuda: AJ.colValorNota, num: true, valor: (c) => c.valor, render: (c) => App.fmt.brl(c.valor), total: (l) => App.fmt.brl(App.soma(l, (c) => c.valor)) },
          { rotulo: "Parte da Engenharia", ajuda: AJ.colEngConta, num: true, valor: (c) => c.eng_parte, render: (c) => el("div", { class: "celula-2l", style: { textAlign: "right" } },
            el("span", {}, App.fmt.brl(c.eng_parte)), el("small", {}, c.eh_poco ? "nota do poço − eventos − locatários" : "nota − o que foi cobrado das áreas"),
            c.valor ? el("small", { class: "sup-pct" }, `${App.fmt.pct(100 * c.eng_parte / c.valor)} da nota`) : null), total: (l) => App.fmt.brl(App.soma(l, (c) => c.eng_parte)) },
          { rotulo: "No budget (CC · projeto · classe)", ajuda: AJ.colBudget, valor: (c) => c.budget_pct, render: (c) => {
            const falta = Math.round((100 - (c.budget_pct || 0)) * 100) / 100;
            const caixa = el("div", { class: "sup-bud" },
              c.budget.length ? c.budget.map((p) => el("div", { class: "sup-bud__linha" + (p.no_budget ? "" : " sup-bud__fora"),
                title: p.no_budget ? "" : `Esta linha não está no budget de ${mes.slice(0, 4)}: o valor não é somado lá.` },
                el("b", {}, p.classe_numero), ` ${p.classe_descricao || ""}`, el("small", {}, ` · CC ${p.centro_custo} · PJ ${p.projeto} · ${App.fmt.pct(p.pct)} = ${App.fmt.brl(p.valor)}`)))
                : el("span", { class: "etiqueta" }, "não vai para o budget"),
              c.budget.length && falta > 0.005 ? el("small", { class: "sup-desc" }, `${App.fmt.pct(falta)} sem classe`) : null);
            if (App.meta.editavel) caixa.append(el("button", { class: "btn btn--mini btn--linha", type: "button",
              onclick: (ev) => { ev.stopPropagation(); supBudgetConta(c, mes, recarregar); } }, c.budget.length ? "Alterar" : "Escolher classes"));
            return caixa;
          } },
        ], d.contas, { onClick: App.meta.editavel ? (c) => supEditarConta(c, recarregar) : null, rodape: true, vazio: "Nenhuma conta lançada neste mês." })));

    /* ---- rateio */
    const q = App.norm(busca.value);
    const linhas = d.linhas.filter((l) => !q || App.norm(`${l.descricao} ${l.centro_custo} ${App.sup.rotCc(l.centro_custo)} ${l.projeto} ${App.sup.rotPj(l.projeto)} ${l.observacao}`).includes(q));
    const editavel = App.meta.editavel;
    const QC = { energia: "energia_kwh", agua: "agua_m3", gas: "gas_m3" };
    const celValor = (l, u) => {
      const porConsumo = l.por_consumo && l.por_consumo[u];
      const campo = porConsumo ? QC[u] : u;                      // linha medida: digita o consumo; o valor sai da tarifa
      const v = l[campo];
      const desc = l.desconto[u];
      const t = d.tarifas[u];
      const nota = el("div", { class: "celula-2l", style: { alignItems: "flex-end" } },
        porConsumo ? el("small", { class: "sup-calc", title: t.tarifa ? `${(+v || 0).toLocaleString("pt-BR")} ${t.unidade} × tarifa de ${supMesCurto(t.base)}` : "sem tarifa" },
          t.tarifa ? `${(+v || 0).toLocaleString("pt-BR")} ${t.unidade} × ${supTarifaTxt(t.tarifa)} = ${App.fmt.brl(l[u])}` : `${(+v || 0).toLocaleString("pt-BR")} ${t.unidade} · sem tarifa`) : null,
        desc ? el("small", { class: "sup-desc" }, `− ${App.fmt.brl(desc)} (${App.fmt.pct(l.desc_pct)})`) : null,
        !porConsumo && l.qtd && l.qtd[u] ? el("small", { class: "sup-calc", title: "consumo do Relatório de eventos" }, `${(+l.qtd[u]).toLocaleString("pt-BR")} ${UNID[u]}`) : null,
        u === "agua" && l.poco_na_agua ? el("small", { class: "sup-calc", title: "poço artesiano somado à água neste mês" }, `+ poço ${App.fmt.brl(l.poco_na_agua)}`) : null,
        l.pct && l.pct[u] ? el("small", { class: "sup-pct" }, `${App.fmt.pct(l.pct[u])} da conta`) : null);
      if (!editavel) return el("div", { class: "celula-2l", style: { textAlign: "right" } }, el("span", {}, porConsumo ? App.fmt.brl(l[u]) : v ? App.fmt.brl(v) : "—"), nota);
      const bonito = (x) => (x ? x.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "");
      const ler = (t) => { t = t.trim().replace(/[R$\s]/g, ""); if (!t) return 0; if (t.includes(",")) t = t.replace(/\./g, "").replace(",", "."); return isNaN(+t) ? NaN : +t; };
      const inp = el("input", { type: "text", inputmode: "decimal", value: bonito(v), placeholder: porConsumo ? UNID[u] : "—", class: "cel-edit" + (porConsumo ? " cel-consumo" : ""),
        "aria-label": `${nomeU[u]} · ${l.descricao}${porConsumo ? ` (consumo em ${UNID[u]})` : ""}`, title: porConsumo ? `Consumo em ${UNID[u]}: o valor é calculado pela tarifa do mês` : "Valor em R$" });
      let cancelou = false;
      inp.addEventListener("focus", () => { inp.value = v ? String(v).replace(".", ",") : ""; inp.select(); });
      inp.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); inp.blur(); }
        if (ev.key === "Escape") { cancelou = true; inp.blur(); }
      });
      inp.addEventListener("blur", async () => {
        const n = ler(inp.value);
        if (cancelou || Number.isNaN(n) || Math.abs(n - (v || 0)) < 0.005) {
          if (Number.isNaN(n)) App.toast("Valor inválido: use só números (ex.: 1500,50).", true);
          cancelou = false; inp.value = bonito(v); return;
        }
        try { await App.api("/api/sup/linhas", { method: "POST", json: { id: l.id, [campo]: n } }); await recarregar(); }
        catch (e) { App.toast(e.message, true); inp.value = bonito(v); }
      });
      inp.addEventListener("click", (ev) => ev.stopPropagation());
      return el("div", { class: "celula-2l", style: { alignItems: "flex-end" } }, inp, nota);
    };
    const UNID = { energia: "kWh", agua: "m³", gas: "m³" };
    const celPoco = (l) => {
      const notas = [l.qtd.poco ? el("small", { class: "sup-calc" }, `${(+l.qtd.poco).toLocaleString("pt-BR")} m³`) : null,
        l.pct.poco ? el("small", { class: "sup-pct" }, `${App.fmt.pct(l.pct.poco)} do poço`) : null];
      if (l.do_relatorio && !l.poco_manual) {   // evento: valor do Relatório de eventos
        return el("div", { class: "celula-2l", style: { alignItems: "flex-end" }, title: "do Relatório de eventos (para trocar, abra a linha)" },
          el("span", {}, l.poco ? App.fmt.brl(l.poco) : "—"), el("small", { class: "ajuda" }, "do Relatório"), ...notas);
      }
      if (!editavel) return el("div", { class: "celula-2l", style: { alignItems: "flex-end" } }, el("span", {}, l.poco ? App.fmt.brl(l.poco) : "—"), ...notas);
      const bonito = (x) => (x ? (+x).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "");
      const ler = (t) => { t = t.trim().replace(/[R$\s]/g, ""); if (!t) return null; if (t.includes(",")) t = t.replace(/\./g, "").replace(",", "."); return isNaN(+t) ? NaN : +t; };
      const inp = el("input", { type: "text", inputmode: "decimal", value: bonito(l.poco), placeholder: "—", class: "cel-edit", "aria-label": `Poço artesiano · ${l.descricao} (R$)`, title: "Valor do poço em R$ (digitado)" });
      let cancelou = false;
      inp.addEventListener("focus", () => { inp.value = l.poco ? String(l.poco).replace(".", ",") : ""; inp.select(); });
      inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); inp.blur(); } if (ev.key === "Escape") { cancelou = true; inp.blur(); } });
      inp.addEventListener("blur", async () => {
        const n = ler(inp.value);
        if (cancelou || Number.isNaN(n) || (n === null && !l.poco_manual) || (n !== null && Math.abs(n - (l.poco || 0)) < 0.005)) {
          if (Number.isNaN(n)) App.toast("Valor inválido: use só números (ex.: 1500,50).", true);
          cancelou = false; inp.value = bonito(l.poco); return;
        }
        try { await App.api("/api/sup/linhas", { method: "POST", json: { id: l.id, poco: n === null ? "" : n } }); await recarregar(); }
        catch (e) { App.toast(e.message, true); inp.value = bonito(l.poco); }
      });
      inp.addEventListener("click", (ev) => ev.stopPropagation());
      return el("div", { class: "celula-2l", style: { alignItems: "flex-end" } }, inp, ...notas);
    };
    const totalCol = (u) => (ls) => App.fmt.brl(App.soma(ls, (l) => l.cobrado[u]));
    const tabela = App.tabela([
      { rotulo: "Linha (quem paga)", ajuda: AJ.colLinha, chave: "linha", total: () => "Repassado às áreas", valor: (l) => l.descricao, render: (l) => el("div", { class: "celula-2l" }, el("b", {}, l.descricao || "—"),
        el("small", {}, `CC ${App.sup.rotCc(l.centro_custo) || "—"} · projeto ${App.sup.rotPj(l.projeto) || "—"}`),
        (!l.centro_custo || !l.projeto) ? el("span", { class: "etiqueta etiqueta--alerta", style: { alignSelf: "flex-start" } }, "Sem código") : null) },
      ...SUP_U.map(([u, nome]) => ({ rotulo: nome, ajuda: AJ.colRateioU(nome.toLowerCase()), chave: u, num: true, valor: (l) => l[u], render: (l) => celValor(l, u), total: totalCol(u) })),
      { rotulo: "Poço artesiano", ajuda: AJ.colRateioPoco, chave: "poco", num: true,
        controle: { visivel: d.poco_separado, nota: "desmarcada = poço somado à conta de água neste mês", mudar: (v) => supPocoColuna(mes, v, recarregar) }, valor: (l) => l.poco, render: (l) => celPoco(l), total: (ls) => App.fmt.brl(App.soma(ls, (l) => l.poco)) },
      { rotulo: "Desconto", ajuda: AJ.colDesconto, chave: "desc", valor: (l) => l.desc_pct, render: (l) => l.desc_pct ? el("span", { class: "etiqueta etiqueta--rateio" },
        `${App.fmt.pct(l.desc_pct)} · ${SUP_U.filter(([u]) => l["desc_" + u]).map(([, , c]) => c).join(", ")}`) : el("span", { class: "ajuda" }, "—") },
      { rotulo: "Cobrado (total)", ajuda: AJ.colCobrado, chave: "total", num: true, valor: (l) => l.total, render: (l) => el("b", {}, App.fmt.brl(l.total)), total: (ls) => App.fmt.brl(App.soma(ls, (l) => l.total)) },
      { rotulo: "Observação", ajuda: "Anotação livre da linha (não entra em nenhum cálculo).", valor: (l) => l.observacao, render: (l) => l.observacao || "" },
    ], linhas, {
      onClick: editavel ? (l) => supEditarLinha(l, mes, recarregar) : null, rodape: true, vazio: "Nenhuma linha de rateio. Use “+ Adicionar linha” ou importe a planilha.",
      selecao: editavel ? { id: (l) => l.id, nome: "linha(s)", acoes: (ids, limpar) => [
        el("button", { class: "btn btn--mini", onclick: () => supDescontoLote(ids(), async () => { limpar(); await recarregar(); }) }, "Aplicar desconto"),
        el("button", { class: "btn btn--mini btn--perigo", onclick: async () => {
          if (!(await App.confirmar("Excluir linhas", `Excluir ${ids().length} linha(s) de rateio? O valor delas volta para a Engenharia.`, "Excluir"))) return;
          await App.api("/api/sup/linhas/excluir", { method: "POST", json: { ids: ids() } }); limpar(); await recarregar();
        } }, "Excluir selecionadas")] } : null,
      rodapeExtra: () => [
        { rotulo: el("b", { title: `CC ${App.sup.rotCc(d.engenharia.centro_custo)} · projeto ${App.sup.rotPj(d.engenharia.projeto)}` }, `Parte da Engenharia · CC ${d.engenharia.centro_custo} · projeto ${d.engenharia.projeto}`), classe: "sup-eng",
          celulas: { ...Object.fromEntries(SUP_U.map(([u]) => [u, el("div", { class: "celula-2l", style: { alignItems: "flex-end" } },
            el("b", { style: { color: T.engenharia[u] < 0 ? "var(--perigo)" : "" } }, App.fmt.brl(T.engenharia[u])),
            T.engenharia_pct[u] !== null ? el("small", { class: "sup-pct" }, `${App.fmt.pct(T.engenharia_pct[u])} da conta`) : null)])),
            poco: T.poco_engenharia !== null ? el("div", { class: "celula-2l", style: { alignItems: "flex-end" } }, el("b", { style: { color: T.poco_engenharia < 0 ? "var(--perigo)" : "" } }, App.fmt.brl(T.poco_engenharia)),
              T.engenharia_pct.poco !== null ? el("small", { class: "sup-pct" }, `${App.fmt.pct(T.engenharia_pct.poco)} do poço`) : null) : "—", total: el("b", {}, App.fmt.brl(soma(T.engenharia))) } },
        { rotulo: "Total das contas", classe: "sup-total",
          celulas: { ...Object.fromEntries(SUP_U.map(([u]) => [u, App.fmt.brl(T.contas[u])])), poco: (T.poco_mes ?? T.poco) ? `${App.fmt.brl(T.poco_mes ?? T.poco)} · ${(+(T.poco_mes_m3 ?? T.poco_m3) || 0).toLocaleString("pt-BR")} m³` : "—", total: App.fmt.brl(soma(T.contas)) } },
      ],
    });
    alvo.append(el("div", { class: "secao" }, el("h3", {}, "2. Quanto cada área paga")),
      App.cartao("Rateio do mês por centro de custo / projeto", "clique no valor para digitar · clique na linha para editar centro de custo, projeto e desconto · o que não é cobrado de ninguém é a Parte da Engenharia",
        el("div", { class: "linha-acoes", style: { marginTop: 0, marginBottom: "10px" } },
          App.btnEditor("+ Adicionar linha", () => supEditarLinha({}, mes, recarregar), "btn btn--mini"),
          App.btnEditor("Puxar consumo do GateX", () => supGatex(mes, d.linhas, recarregar, d.tarifas.energia), "btn btn--mini btn--sec"),
          App.btnEditor("Trazer eventos do Relatório", async () => {
            try {
              const r = await App.api(`/api/sup/meses/${mes}/eventos`, { method: "POST" });
              App.toast(r.novos.length ? `${r.novos.length} evento(s) incluído(s) com energia, água e gás do Relatório de eventos.` : "Nenhum evento novo: os eventos do mês já têm linha (nada foi alterado).");
              await recarregar();
            } catch (e) { App.toast(e.message, true); }
          }, "btn btn--mini btn--linha")), tabela));

    /* ---- gráfico: para onde vai cada conta */
    if (soma(T.contas)) {
      const porCc = App.agrupar(d.linhas, (l) => l.centro_custo || "");
      const ccs = Object.keys(porCc).sort((a, b) => App.soma(porCc[b], (l) => l.total) - App.soma(porCc[a], (l) => l.total));
      const paleta = ["#6A0BB0", "#A876F0", "#2E7DB5", "#E08A1E", "#B42318", "#8D6E63", "#0E9384", "#C11574", "#667085", "#CBA5FD"];
      const g = G.area("grafico");
      alvo.append(el("div", { class: "secao" }, el("h3", {}, "3. Para onde foi o valor de cada conta")),
        App.cartao("Divisão de cada conta entre os centros de custo", "valor cobrado de cada centro de custo e a Parte da Engenharia",
          G.legenda([...ccs.map((c, i) => [App.sup.rotCc(c) || "Sem centro de custo", paleta[i % paleta.length]]), ["Parte da Engenharia", SUP_CORES.eng]]), g.div));
      G.barrasHEmpilhadas(g.canvas, SUP_U.map(([, n]) => n), [
        ...ccs.map((c, i) => ({ rotulo: App.sup.rotCc(c) || "Sem centro de custo", cor: paleta[i % paleta.length], valores: SUP_U.map(([u]) => App.soma(porCc[c], (l) => l.cobrado[u])) })),
        { rotulo: "Parte da Engenharia", cor: SUP_CORES.eng, valores: SUP_U.map(([u]) => Math.max(0, T.engenharia[u])) }]);
    }

    /* ---- tarifas */
    alvo.append(el("div", { class: "secao" }, el("h3", {}, "4. Tarifas usadas no cálculo")),
      App.cartao("Tarifa do mês (R$ por kWh / m³)", `valor da conta ÷ consumo da conta de ${supMesNome(d.tarifas.energia.base)} · usada nas linhas em que você digita o consumo`,
        el("div", { class: "sup-tarifas" }, SUP_U.map(([u, nome]) => {
          const t = d.tarifas[u];
          return el("div", { class: "sup-tarifa" + (t.tarifa ? "" : " sup-tarifa--falta") },
            el("span", { class: "sup-tarifa__nome" }, nome),
            el("b", {}, t.tarifa ? `${supTarifaTxt(t.tarifa)} / ${t.unidade}` : "sem tarifa"),
            el("small", {}, t.manual ? "tarifa digitada" : t.fatura && t.consumo ? `${App.fmt.brl(t.fatura)} ÷ ${t.consumo.toLocaleString("pt-BR")} ${t.unidade}` : `falta a conta de ${supMesCurto(t.base)}`),
            App.btnEditor(t.tarifa ? "Editar" : "Preencher", () => supEditarTarifa(u, t, recarregar), "btn btn--mini btn--linha"));
        }))));
  }
  await recarregar();
}

/** Poço com coluna própria ou somado à água no mês (não apaga nada: os valores voltam quando a coluna volta). */
async function supPocoColuna(mes, separado, aoSalvar) {
  const txt = separado
    ? "A coluna Poço artesiano volta para este mês. A conta “Poço Artesiano” sai da água e vira o total do poço; os eventos voltam com o poço do Relatório de eventos (valores atuais do relatório) e os locatários com o valor que já estava digitado."
    : "O poço artesiano deixa de ter coluna própria neste mês: a conta “Poço Artesiano” passa a somar na conta de água (como Enel + Esfera na energia) e o poço de cada linha (eventos e locatários) entra no valor de água da linha. Nada é apagado: dá para voltar a coluna depois.";
  if (!(await App.confirmar(separado ? "Mostrar a coluna do poço" : "Somar o poço à água", txt, separado ? "Mostrar coluna" : "Somar à água"))) return false;
  try {
    await App.api(`/api/sup/meses/${mes}/poco-coluna`, { method: "POST", json: { separado } });
    App.fecharAjuda(); App.toast(separado ? "Poço artesiano com coluna própria neste mês." : "Poço artesiano somado à água neste mês.");
    await aoSalvar();
    return true;
  } catch (e) { App.toast(e.message, true); return false; }
}

/* ------------------------------------------------------------------ tarifas */
const supTarifaTxt = (t) => "R$ " + (+t).toLocaleString("pt-BR", { minimumFractionDigits: 4, maximumFractionDigits: 4 });

function supEditarTarifa(u, t, aoSalvar) {
  const nome = SUP_U.find((x) => x[0] === u)[1];
  const mes = el("input", { type: "month", value: t.base });
  const fatura = el("input", { type: "number", step: "0.01", min: "0", value: t.fatura ?? "" });
  const consumo = el("input", { type: "number", step: "0.01", min: "0", value: t.consumo ?? "" });
  const manual = el("input", { type: "number", step: "0.0001", min: "0", value: t.manual ? t.tarifa : "", placeholder: "deixe vazio para calcular" });
  const previa = el("p", { class: "ajuda" });
  const calc = () => {
    const tf = +manual.value || ((+fatura.value && +consumo.value) ? +fatura.value / +consumo.value : 0);
    previa.textContent = tf ? `Tarifa: ${supTarifaTxt(tf)} por ${t.unidade}` : "Preencha a conta e o consumo (ou digite a tarifa).";
  };
  [fatura, consumo, manual].forEach((x) => x.addEventListener("input", calc));
  calc();
  const msg = el("p", { class: "ajuda", style: { color: "var(--perigo)", minHeight: "18px" } });
  App.modal(el("div", {}, el("h3", {}, `Tarifa · ${nome}`),
    el("p", { class: "ajuda", style: { marginTop: 0 } }, `A tarifa é o valor total da conta do mês dividido pelo consumo do mês (${t.unidade}). Por padrão a medição de um mês usa a conta do mês anterior (Configurações).`),
    el("div", { class: "grade-form", style: { gridTemplateColumns: "1fr 1fr" } },
      App.campo("Mês da conta", mes), App.campo("Conta total do mês (R$)", fatura),
      App.campo(`Consumo do mês (${t.unidade})`, consumo), App.campo(`Ou a tarifa direto (R$/${t.unidade})`, manual)),
    previa, msg,
    el("div", { class: "linha-acoes" }, el("button", { class: "btn", onclick: async () => {
      try {
        await App.api("/api/sup/tarifas", { method: "POST", json: { mes: mes.value, utilidade: u, fatura: fatura.value, consumo: consumo.value, tarifa: manual.value } });
        App.fecharModal(); App.toast("Tarifa salva."); await aoSalvar();
      } catch (e) { msg.textContent = e.message; }
    } }, "Salvar"), el("button", { class: "btn btn--linha", "data-fechar": "" }, "Cancelar"))));
}

/* ------------------------------------------------------------------ edição */
function supEditarConta(c, aoSalvar) {
  const novo = !c.id;
  const util = el("select", {}, SUP_U.map(([u, n]) => el("option", { value: u, selected: c.utilidade === u }, n)));
  const forn = el("input", { type: "text", value: c.fornecedor || "", placeholder: "ex.: Enel, Esfera, Sabesp, Comgás", list: "sup-forn" });
  const lista = el("datalist", { id: "sup-forn" }, ["Enel", "Esfera", "Sabesp", "Comgás", "Poço Artesiano"].map((f) => el("option", { value: f })));
  const doc = el("input", { type: "text", value: c.numero_doc || "" });
  const emi = el("input", { type: "date", value: c.data_emissao || "" }), ven = el("input", { type: "date", value: c.data_vencimento || "" });
  const valor = el("input", { type: "number", step: "0.01", min: "0", value: c.valor ?? "" });
  const obs = el("input", { type: "text", value: c.observacao || "" });
  forn.addEventListener("change", () => {   // sugere o tipo pelo fornecedor
    const t = App.norm(forn.value);
    const u = /enel|esfera|eletropaulo/.test(t) ? "energia" : /sabesp|saneamento/.test(t) ? "agua" : /comgas/.test(t) ? "gas" : null;
    if (u && novo) util.value = u;
  });
  const msg = el("p", { class: "ajuda", style: { color: "var(--perigo)", minHeight: "18px" } });
  App.modal(el("div", {}, el("h3", {}, novo ? "Nova conta" : "Editar conta"), lista,
    el("div", { class: "grade-form", style: { gridTemplateColumns: "1fr 1fr" } },
      App.campo("Fornecedor", forn), App.campo("Conta", util), App.campo("Nº do documento", doc), App.campo("Valor (R$)", valor),
      App.campo("Emissão", emi), App.campo("Vencimento", ven), el("label", { class: "campo campo--largo" }, el("span", {}, "Observação"), obs)),
    msg,
    el("div", { class: "linha-acoes" },
      el("button", { class: "btn", onclick: async () => {
        try {
          await App.api("/api/sup/contas", { method: "POST", json: { id: c.id, mes: c.mes, utilidade: util.value, fornecedor: forn.value, numero_doc: doc.value,
            data_emissao: emi.value, data_vencimento: ven.value, valor: valor.value, observacao: obs.value } });
          App.fecharModal(); await aoSalvar();
        } catch (e) { msg.textContent = e.message; }
      } }, "Salvar"),
      el("button", { class: "btn btn--linha", "data-fechar": "" }, "Cancelar"),
      novo ? null : el("button", { class: "btn btn--perigo", style: { marginLeft: "auto" }, onclick: async () => {
        if (!(await App.confirmar("Excluir conta", `Excluir a conta ${c.fornecedor || ""} de ${App.fmt.brl(c.valor)}?`, "Excluir"))) return;
        await App.api(`/api/sup/contas/${c.id}`, { method: "DELETE" }); await aoSalvar();
      } }, "Excluir"))));
}

/** Parte da Engenharia de uma conta -> linhas do budget do ano (centro de custo + projeto + classe), em %. */
async function supBudgetConta(c, mes, aoSalvar) {
  const ano = mes.slice(0, 4);
  let linhasBud = [];
  try { linhasBud = await App.api(`/api/sup/budget-linhas?ano=${ano}`); } catch (e) { App.toast(e.message, true); return; }
  if (!linhasBud.length) { App.toast(`O budget de ${ano} ainda não tem linhas. Cadastre o budget do ano primeiro.`, true); return; }
  const C = App.sup.base.config;
  const daEng = (l) => (!C.cc_engenharia || l.centro_custo === C.cc_engenharia) && (!C.projeto_engenharia || l.projeto === C.projeto_engenharia);
  const rot = (l) => `${l.classe_numero} ${l.classe_descricao || ""} · CC ${l.centro_custo}${l.cc_desc ? " " + l.cc_desc : ""} · PJ ${l.projeto}${l.pj_desc ? " " + l.pj_desc : ""}`;
  const eng = linhasBud.filter(daEng), outras = linhasBud.filter((l) => !daEng(l));
  const nomeU = Object.fromEntries(SUP_U.map(([u, n]) => [u, n]));
  const corpo = el("div", { class: "sup-budlist" });
  const linhas = [];
  const total = el("b"), aviso = el("p", { class: "ajuda", style: { color: "var(--perigo)", minHeight: "18px" } });
  const brl = (v) => App.fmt.brl(v);
  const ler = (t) => { t = String(t || "").trim().replace(/[R$\s]/g, ""); if (!t) return null; if (t.includes(",")) t = t.replace(/\./g, "").replace(",", "."); return isNaN(+t) ? NaN : +t; };
  const bonito = (v) => (v === null || v === undefined || v === "" ? "" : (+v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  // valor da Engenharia: digitado (vale ele) ou vazio (usa o calculado pelo rateio do mês)
  const base = () => c.eng_parte;
  function atualizar(origem) {
    const B = base();
    linhas.forEach((x) => { if (x !== origem) x.valor.value = bonito(B * (+x.pct.value || 0) / 100); });
    const soma = linhas.reduce((t, x) => t + (+x.pct.value || 0), 0);
    total.textContent = `${App.fmt.pct(soma)} = ${brl(B * soma / 100)}`;
    total.style.color = soma > 100.005 ? "var(--perigo)" : "";
    aviso.textContent = soma > 100.005 ? "A soma passa de 100%." : soma > 0 && soma < 99.995 ? `Faltam ${App.fmt.pct(100 - soma)}: essa parte não vai para nenhuma classe.` : "";
  }
  function addLinha(itemId = "", pct = "") {
    const sel = el("select", { "aria-label": "Linha do budget" }, el("option", { value: "" }, "— escolha a linha do budget —"),
      eng.length ? el("optgroup", { label: "Engenharia (CC e projeto das Configurações)" }, eng.map((l) => el("option", { value: l.id }, rot(l)))) : null,
      outras.length ? el("optgroup", { label: "Outras linhas do budget" }, outras.map((l) => el("option", { value: l.id }, rot(l)))) : null);
    sel.value = String(itemId || "");
    const dica = () => { sel.title = sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : ""; };
    sel.addEventListener("change", dica);
    if (itemId && !sel.value) sel.prepend(el("option", { value: itemId, selected: true }, "(linha fora do budget deste ano)"));
    const p = el("input", { type: "number", step: "0.01", min: "0", max: "100", value: pct, style: { width: "90px" }, "aria-label": "%" });
    const v = el("input", { type: "text", inputmode: "decimal", "aria-label": "Valor (R$)", placeholder: "R$", style: { width: "120px", textAlign: "right" } });
    const x = { sel, pct: p, valor: v };
    v.addEventListener("input", () => {   // digitou o valor em R$: calcula o %
      const val = ler(v.value), B = base();
      p.value = val && B ? Math.round(10000 * val / B) / 100 : "";
      atualizar(x);
    });
    const tr = el("div", { class: "sup-budlist__linha" }, sel, el("span", { class: "sup-budlist__pct" }, p, " %"), el("span", { class: "sup-budlist__valor" }, "R$ ", v),
      el("button", { class: "btn btn--mini btn--linha", type: "button", "aria-label": "Remover linha", onclick: () => {
        linhas.splice(linhas.indexOf(x), 1); tr.remove(); atualizar(); } }, "Remover"));
    p.addEventListener("input", () => atualizar());
    linhas.push(x); corpo.append(tr); atualizar(); dica();
    return x;
  }
  (c.budget.length ? c.budget : []).forEach((p) => addLinha(p.item_id, p.pct));
  if (!linhas.length) addLinha("", 100);
  App.modal(el("div", { class: "modal--largo" },
    el("h3", {}, `Budget · ${nomeU[c.utilidade]} ${c.fornecedor || ""}`),
    el("div", { class: "sup-engval" }, el("div", {}, "Parte da Engenharia nesta conta: ", el("b", {}, brl(c.eng_parte))),
      el("p", { class: "ajuda" }, c.eh_poco ? "É o que sobra do poço do mês depois dos eventos e locatários (mesmo valor da linha Engenharia no Rateio)."
        : `É a Parte da Engenharia desta conta no Rateio do mês (conta de ${brl(c.valor)}). Para mudar, ajuste as linhas do rateio.`)),
    el("p", { class: "ajuda" }, `Divida entre as linhas do budget de ${ano}, em % ou em R$. Contas novas do mesmo tipo e fornecedor já vêm com esta divisão (o valor da Engenharia você digita em cada mês).`),
    el("div", { class: "sup-budlist__cab" }, el("span", {}, "Linha do budget (classe · centro de custo · projeto)"), el("span", {}, "%"), el("span", {}, "Valor"), el("span")),
    corpo,
    el("div", { class: "sup-budlist__total" }, el("span", {}, "Total"), total),
    el("div", { class: "linha-acoes", style: { marginTop: "8px" } },
      el("button", { class: "btn btn--mini btn--linha", type: "button", onclick: () => addLinha("", "").sel.focus() }, "+ Linha"),
      el("button", { class: "btn btn--mini btn--linha", type: "button", onclick: () => {
        const n = linhas.length; if (!n) return;
        const base = Math.floor(10000 / n) / 100;
        linhas.forEach((x, i) => { x.pct.value = i === n - 1 ? Math.round((100 - base * (n - 1)) * 100) / 100 : base; });
        atualizar();
      } }, "Dividir igualmente")),
    aviso,
    el("div", { class: "linha-acoes" },
      el("button", { class: "btn", onclick: async () => {
        const partes = linhas.filter((x) => x.sel.value).map((x) => ({ item_id: +x.sel.value, pct: x.pct.value }));
        if (linhas.some((x) => !x.sel.value && +x.pct.value)) { aviso.textContent = "Escolha a linha do budget em todas as linhas com %."; return; }
        try { await App.api(`/api/sup/contas/${c.id}/budget`, { method: "POST", json: { partes, eng_valor: "" } }); App.fecharModal(); App.toast("Conta ligada ao budget."); await aoSalvar(); }
        catch (e) { aviso.textContent = e.message; }
      } }, "Salvar"),
      c.budget.length ? el("button", { class: "btn btn--linha", onclick: async () => {
        await App.api(`/api/sup/contas/${c.id}/budget`, { method: "POST", json: { partes: [] } }); App.fecharModal(); await aoSalvar();
      } }, "Tirar do budget") : null,
      el("button", { class: "btn btn--linha", "data-fechar": "" }, "Cancelar"))));
}

/** Lista de centros de custo / projetos com opção de cadastrar um novo ali mesmo (sem fechar a janela).
    Devolve { el, value }. */
function supSeletor(tipo, valor, aoMudar) {
  const B = App.sup.base;
  const lista = tipo === "cc" ? B.centros : B.projetos;
  const rot = tipo === "cc" ? App.sup.rotCc : App.sup.rotPj;
  const s = el("select");
  const encher = (v) => {
    App.limpar(s).append(el("option", { value: "" }, "—"), ...lista.map((x) => el("option", { value: x.nome, selected: x.nome === v }, rot(x.nome))),
      el("option", { value: "__novo" }, tipo === "cc" ? "+ Cadastrar centro de custo…" : "+ Cadastrar projeto…"));
    if (v && !lista.some((x) => x.nome === v)) s.insertBefore(el("option", { value: v, selected: true }, v + " (não cadastrado)"), s.options[1]);
  };
  encher(valor);
  let anterior = valor || "";
  const num = el("input", { type: "text", placeholder: "nº", "aria-label": "Número" });
  const desc = el("input", { type: "text", placeholder: "descrição", "aria-label": "Descrição" });
  const caixa = el("div", { class: "sup-novo", hidden: true }, num, desc,
    el("button", { class: "btn btn--mini", type: "button", onclick: async () => {
      if (!num.value.trim()) { num.focus(); return; }
      try {
        const r = await App.api("/api/sup/cadastro", { method: "POST", json: { tipo, nome: num.value, descricao: desc.value } });
        if (!lista.some((x) => x.nome === r.nome)) lista.push({ nome: r.nome, descricao: desc.value });
        encher(r.nome); anterior = r.nome; caixa.hidden = true; num.value = desc.value = ""; s.focus(); aoMudar && aoMudar();
      } catch (e) { App.toast(e.message, true); }
    } }, "Adicionar"),
    el("button", { class: "btn btn--mini btn--linha", type: "button", onclick: () => { caixa.hidden = true; s.focus(); } }, "Cancelar"));
  s.onchange = () => {
    if (s.value !== "__novo") { anterior = s.value; aoMudar && aoMudar(); return; }
    s.value = anterior; caixa.hidden = false; num.focus();
  };
  return { el: el("div", {}, s, caixa), get value() { return s.value; } };
}

function supEditarLinha(l, mes, aoSalvar) {
  const novo = !l.id;
  const desc = el("input", { type: "text", value: l.descricao || "", placeholder: "ex.: Loja Exemplo, TIME A x TIME B - 04/09/26" });
  const cc = supSeletor("cc", l.centro_custo || "", () => {});
  const pj = supSeletor("pj", l.projeto || "", () => { if (!desc.value && pj.value) desc.value = (App.sup.base.projetos.find((p) => p.nome === pj.value) || {}).descricao || ""; });
  const vals = Object.fromEntries(SUP_U.map(([u]) => [u, el("input", { type: "number", step: "0.01", min: "0", value: l[u] || "" })]));
  const QC = { energia: "energia_kwh", agua: "agua_m3", gas: "gas_m3" }, UN = { energia: "kWh", agua: "m³", gas: "m³" };
  const cons = Object.fromEntries(SUP_U.map(([u]) => [u, el("input", { type: "number", step: "0.01", min: "0", value: l[QC[u]] ?? "", placeholder: "não medido" })]));
  SUP_U.forEach(([u]) => { const sync = () => { vals[u].disabled = cons[u].value !== ""; if (vals[u].disabled) vals[u].placeholder = "calculado pela tarifa"; }; cons[u].addEventListener("input", sync); sync(); });
  const pct = el("input", { type: "number", step: "0.01", min: "0", max: "100", value: l.desc_pct || "" });
  const flags = Object.fromEntries(SUP_U.map(([u]) => [u, el("input", { type: "checkbox", checked: !!l["desc_" + u], style: { width: "auto", margin: 0 } })]));
  const obs = el("input", { type: "text", value: l.observacao || "" });
  // poço artesiano: só o que foi digitado (evento sem nada digitado usa o do Relatório de eventos)
  const pocoV = el("input", { type: "number", step: "0.01", min: "0", value: l.poco_manual ? l.poco : "", placeholder: l.do_relatorio && l.poco ? `${l.poco} (do Relatório)` : "—" });
  const pocoQ = el("input", { type: "number", step: "0.01", min: "0", value: l.poco_manual ? (l.qtd.poco ?? "") : "", placeholder: l.do_relatorio && l.qtd && l.qtd.poco ? `${l.qtd.poco} (do Relatório)` : "—" });
  const previa = el("div", { class: "ajuda" });
  const calc = () => {
    const p = +pct.value || 0;
    const partes = SUP_U.map(([u, n]) => { const v = +vals[u].value || 0; const d = flags[u].checked ? v * p / 100 : 0; return d ? `${n}: cobra ${App.fmt.brl(v - d)} (desconto ${App.fmt.brl(d)})` : null; }).filter(Boolean);
    previa.textContent = p && partes.length ? partes.join(" · ") + " — o desconto volta para a Engenharia." : "";
  };
  [pct, ...Object.values(vals), ...Object.values(flags)].forEach((x) => x.addEventListener("input", calc));
  Object.values(flags).forEach((x) => x.addEventListener("change", calc));
  calc();
  const msg = el("p", { class: "ajuda", style: { color: "var(--perigo)", minHeight: "18px" } });
  App.modal(el("div", { class: "modal--largo" }, el("h3", {}, novo ? "Nova linha de rateio" : `Linha: ${l.descricao || ""}`),
    el("div", { class: "grade-form" },
      el("label", { class: "campo campo--largo" }, el("span", {}, "Nome da linha"), desc),
      App.campo("Centro de custo", cc.el), App.campo("Projeto", pj.el), el("div", {}),
      ...SUP_U.map(([u, n]) => App.campo(`${n} · consumo medido (${UN[u]})`, cons[u])),
      ...SUP_U.map(([u, n]) => App.campo(`${n} (R$)`, vals[u]))),
    el("p", { class: "ajuda" }, "Com o consumo preenchido, o valor é consumo × tarifa do mês (Tarifas do mês). Sem consumo, vale o valor em R$ digitado."),
    el("div", { class: "grade-form", style: { gridTemplateColumns: "1fr 1fr" } },
      App.campo("Poço artesiano (m³)", pocoQ), App.campo("Poço artesiano (R$)", pocoV)),
    el("p", { class: "ajuda" }, "Poço artesiano aparece à parte nos relatórios (não entra na conta da Sabesp). Em linhas de evento, vazio = usa o poço do Relatório de eventos."),
    el("div", { class: "bloco-budget" }, el("h4", {}, "Desconto"),
      el("p", { class: "ajuda", style: { marginTop: 0 } }, "Tira uma porcentagem do valor desta linha nas contas marcadas. A parte descontada volta para a Engenharia."),
      el("div", { class: "grade-form" }, App.campo("Desconto (%)", pct),
        el("div", { class: "campo", style: { gridColumn: "span 2" } }, el("span", {}, "Vale para"),
          el("div", { class: "chips", style: { gap: "14px" } }, SUP_U.map(([u, n]) => el("label", { style: { display: "flex", gap: "6px", alignItems: "center" } }, flags[u], n))))),
      previa),
    el("label", { class: "campo", style: { marginTop: "10px" } }, el("span", {}, "Observação"), obs),
    msg,
    el("div", { class: "linha-acoes" },
      el("button", { class: "btn", onclick: async () => {
        if (+pct.value && !SUP_U.some(([u]) => flags[u].checked)) { msg.textContent = "Marque em quais contas o desconto vale."; return; }
        try {
          await App.api("/api/sup/linhas", { method: "POST", json: { id: l.id, mes, descricao: desc.value, centro_custo: cc.value, projeto: pj.value,
            ...Object.fromEntries(SUP_U.map(([u]) => [u, vals[u].value])), ...Object.fromEntries(SUP_U.map(([u]) => [QC[u], cons[u].value])), desc_pct: pct.value || 0,
            ...Object.fromEntries(SUP_U.map(([u]) => ["desc_" + u, flags[u].checked])), observacao: obs.value, poco: pocoV.value, poco_m3: pocoQ.value } });
          App.fecharModal(); await aoSalvar();
        } catch (e) { msg.textContent = e.message; }
      } }, "Salvar"),
      el("button", { class: "btn btn--linha", "data-fechar": "" }, "Cancelar"),
      novo ? null : el("button", { class: "btn btn--perigo", style: { marginLeft: "auto" }, onclick: async () => {
        if (!(await App.confirmar("Excluir linha", `Excluir “${l.descricao}”? O valor dela volta para a Engenharia.`, "Excluir"))) return;
        await App.api("/api/sup/linhas/excluir", { method: "POST", json: { ids: [l.id] } }); await aoSalvar();
      } }, "Excluir"))));
}

function supDescontoLote(ids, aoSalvar) {
  const pct = el("input", { type: "number", step: "0.01", min: "0", max: "100", placeholder: "ex.: 20" });
  const flags = Object.fromEntries(SUP_U.map(([u]) => [u, el("input", { type: "checkbox", checked: u === "energia", style: { width: "auto", margin: 0 } })]));
  const msg = el("p", { class: "ajuda", style: { color: "var(--perigo)", minHeight: "18px" } });
  App.modal(el("div", {}, el("h3", {}, `Desconto em ${ids.length} linha(s)`),
    el("p", { class: "ajuda", style: { marginTop: 0 } }, "Tira a porcentagem do valor das linhas escolhidas, só nas contas marcadas. A parte descontada volta para a Engenharia. Use 0 para tirar o desconto."),
    el("div", { class: "grade-form", style: { gridTemplateColumns: "1fr 2fr" } }, App.campo("Desconto (%)", pct),
      el("div", { class: "campo" }, el("span", {}, "Vale para"), el("div", { class: "chips", style: { gap: "14px" } },
        SUP_U.map(([u, n]) => el("label", { style: { display: "flex", gap: "6px", alignItems: "center" } }, flags[u], n))))),
    msg,
    el("div", { class: "linha-acoes" }, el("button", { class: "btn", onclick: async () => {
      try {
        await App.api("/api/sup/linhas/desconto", { method: "POST", json: { ids, pct: pct.value || 0, ...Object.fromEntries(SUP_U.map(([u]) => [u, flags[u].checked])) } });
        App.fecharModal(); App.toast(+pct.value ? `Desconto de ${pct.value}% aplicado.` : "Desconto retirado."); await aoSalvar();
      } catch (e) { msg.textContent = e.message; }
    } }, "Aplicar"), el("button", { class: "btn btn--linha", "data-fechar": "" }, "Cancelar"))));
}

/* ------------------------------------------------------------------ GATEX */
/** Lê o GateX (valor de energia de cada locatário e custo de cada evento) e lança na coluna Energia das linhas.
    Cada item do GateX vai para uma linha (várias podem ir para a mesma: os valores somam), vira linha nova ou é ignorado.
    O destino escolhido fica guardado para os próximos meses. */
async function supGatex(mes, linhas, aoSalvar, tarifa) {
  const tf = (tarifa && tarifa.tarifa) || 0;
  App.toast("Lendo o GateX…");
  let g;
  try { g = await App.api(`/api/sup/gatex?mes=${mes}`); }
  catch (e) {
    App.modal(el("div", {}, el("h3", {}, "Não consegui ler o GateX"), el("p", {}, e.message),
      el("div", { class: "linha-acoes" }, el("a", { class: "btn", href: "#/sup/config", "data-fechar": "" }, "Abrir Configurações"),
        el("button", { class: "btn btn--linha", "data-fechar": "" }, "Fechar"))));
    return;
  }
  const chave = (t) => App.norm(t).replace(/[^a-z0-9]/g, "");
  const porDescricao = Object.fromEntries(linhas.map((l) => [l.descricao, l]));
  const sugestao = (it) => {
    if (it.tipo === "evento") {   // eventos já vêm do Relatório de eventos (R$ de energia, água e gás): por padrão não mexe
      const dm = it.data ? `${it.data.slice(8, 10)}/${it.data.slice(5, 7)}` : "";
      const l = linhas.find((x) => x.evento_id && (x.descricao || "").includes(dm));
      if (l && !(it.mapa && !it.mapa.ignorar)) return "ignorar";
    }
    if (it.mapa) return it.mapa.ignorar ? "ignorar" : (porDescricao[it.mapa.descricao] ? String(porDescricao[it.mapa.descricao].id) : "nova");
    if (it.tipo === "evento" && it.data) {   // evento: mesma data (dd/mm) no nome da linha
      const dm = `${it.data.slice(8, 10)}/${it.data.slice(5, 7)}`;
      const l = linhas.filter((x) => (x.descricao || "").includes(dm));
      if (l.length === 1) return String(l[0].id);
    }
    // operadoras de telefonia (antenas) entram todas na linha "Sistema de Telecomunicações"
    const nomeN = (it.nome || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    if (/\b(vivo|tim|claro|high ?line)\b/.test(nomeN)) {
      const tel = linhas.find((x) => chave(x.descricao).includes("telecomunica"));
      if (tel) return String(tel.id);
    }
    const k = chave(it.nome);
    const l = linhas.find((x) => { const lk = chave(x.descricao); return lk && k && (lk.includes(k) || k.includes(lk)); });
    if (l) return String(l.id);
    return /arenademo/.test(k) ? "ignorar" : "nova";
  };
  const opcoes = [["ignorar", "— não lançar"], ["nova", "+ nova linha com este nome"], ...linhas.map((l) => [String(l.id), l.descricao || "(sem nome)"])];
  const sels = g.itens.map((it) => {
    const s = el("select", { "aria-label": `Destino de ${it.nome}` }, opcoes.map(([v, r]) => el("option", { value: v }, r)));
    s.value = sugestao(it);
    return s;
  });
  const previa = el("div");
  const atualizar = () => {
    const somas = {};
    g.itens.forEach((it, i) => { const v = sels[i].value; if (v !== "ignorar" && v !== "nova") somas[v] = (somas[v] || 0) + it.kwh; });
    const mudam = linhas.filter((l) => somas[l.id] !== undefined && Math.abs(somas[l.id] - (l.energia_kwh || 0)) > 0.005);
    const novas = sels.filter((s) => s.value === "nova").length;
    App.limpar(previa).append(el("p", { class: "ajuda" }, `${mudam.length} linha(s) vão mudar de consumo de energia${novas ? ` · ${novas} linha(s) nova(s) (escolha centro de custo e projeto depois)` : ""}. Água e gás não mudam.`
      + (tf ? "" : " Atenção: falta a tarifa de energia do mês; o consumo é gravado e o valor aparece quando a tarifa for preenchida.")));
  };
  sels.forEach((s) => s.addEventListener("change", atualizar));
  atualizar();
  const tabela = el("table", { class: "tabela" },
    el("thead", {}, el("tr", {}, ["Item do GateX", "Data", "Consumo", "Valor pela tarifa", "Lançar em"].map((t, i) => el("th", { class: i === 2 || i === 3 ? "num" : "" }, t)))),
    el("tbody", {}, g.itens.map((it, i) => el("tr", {},
      el("td", {}, el("div", { class: "celula-2l" }, el("b", {}, it.nome), el("small", {}, it.tipo === "evento" ? "evento" : "locatário"))),
      el("td", {}, it.data ? App.fmt.dataCurta(it.data) : ""),
      el("td", { class: "num" }, `${it.kwh.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} kWh`),
      el("td", { class: "num" }, tf ? App.fmt.brl(it.kwh * tf) : "—"),
      el("td", {}, sels[i])))));
  const msg = el("p", { class: "ajuda", style: { color: "var(--perigo)", minHeight: "18px" } });
  const r = g.resumo || {};
  App.modal(el("div", { class: "modal--extra" }, el("h3", {}, `Energia do GateX · ${supMesNome(mes)}`),
    el("p", { class: "ajuda", style: { marginTop: 0 } },
      `Consumo de energia (kWh) medido pelo GateX para cada locatário e evento. O valor é kWh × tarifa do mês (${tf ? supTarifaTxt(tf) + "/kWh" : "sem tarifa"}), a mesma conta da planilha de consumos. Escolha em qual linha cada item entra: vários podem ir para a mesma linha (somam). O que você escolher fica guardado para os próximos meses.`
      + (r.enel_kwh ? ` Consumo ENEL no mês: ${r.enel_kwh.toLocaleString("pt-BR")} kWh.` : "")),
    el("div", { class: "tabela-wrap tabela-wrap--alta" }, tabela), previa, msg,
    el("div", { class: "linha-acoes" }, el("button", { class: "btn", onclick: async () => {
      try {
        const res = await App.api("/api/sup/gatex/lancar", { method: "POST", json: { mes, itens: g.itens.map((it, i) => ({ chave: it.chave, nome: it.nome, valor: it.valor, kwh: it.kwh, destino: sels[i].value })) } });
        App.fecharModal();
        App.toast(`Consumo de energia lançado em ${res.linhas} linha(s)${res.novas.length ? ` · ${res.novas.length} nova(s): escolha centro de custo e projeto` : ""}.`);
        await aoSalvar();
      } catch (e) { msg.textContent = e.message; }
    } }, "Lançar energia nas linhas"), el("button", { class: "btn btn--linha", "data-fechar": "" }, "Cancelar"))));
}

/* ------------------------------------------------------------------ RESUMO */
const SUP_GRUPOS = [["engenharia", "Engenharia", "#4F8F33"], ["locatario", "Locatários e áreas", "#6A0BB0"], ["show", "Shows", "#A876F0"],
  ["jogo", "Jogos", "#2E7DB5"], ["projeto_especial", "Projetos especiais", "#E08A1E"]];

async function supResumo(corpo) {
  const todos = App.sup.base.meses.map((m) => m.mes).sort();
  if (!todos.length) { corpo.append(el("div", { class: "cartao vazio" }, "Nenhum mês lançado ainda.")); return; }
  let dados;
  try { dados = await App.api("/api/sup/linhas"); } catch (e) { corpo.append(el("div", { class: "cartao vazio" }, e.message)); return; }
  const est = { de: todos[0], ate: todos[todos.length - 1], grupos: [], contas: [], cc: "", pj: "", q: "" };
  try { Object.assign(est, JSON.parse(sessionStorage.getItem("sup_resumo") || "{}")); } catch (e) { /* ok */ }
  if (!todos.includes(est.de)) est.de = todos[0];
  if (!todos.includes(est.ate)) est.ate = todos[todos.length - 1];
  const salvar = () => { try { sessionStorage.setItem("sup_resumo", JSON.stringify(est)); } catch (e) { /* ok */ } };
  App.exportarExcel = [
    { titulo: "Excel · planilha do setor", rotulo: "requisitante + Suprimentos de cada mês do período (um arquivo por mês; vários meses vêm num .zip)",
      url: () => `/api/sup/planilha?de=${est.de}&ate=${est.ate}` },
    { titulo: "Excel · base do site", rotulo: "RATEIO, CONTAS e RESUMO de todos os meses do ano", url: () => `/api/sup/exportar?ano=${est.ate.slice(0, 4)}` }];

  /* ---- filtros */
  const opMes = (v) => todos.map((m) => el("option", { value: m, selected: m === v }, supMesNome(m)));
  const selDe = el("select", { "aria-label": "Mês inicial" }, opMes(est.de)), selAte = el("select", { "aria-label": "Mês final" }, opMes(est.ate));
  const anos = [...new Set(todos.map((m) => m.slice(0, 4)))].sort().reverse();
  const chipsAno = anos.map((a) => { const b = el("button", { class: "chip chip--mini" }, a); b.onclick = () => { const ms = todos.filter((m) => m.startsWith(a)); est.de = ms[0]; est.ate = ms[ms.length - 1]; selDe.value = est.de; selAte.value = est.ate; mudar(); }; return b; });
  const chipsMulti = (lista, chave) => lista.map(([v, r, cor]) => {
    const b = el("button", { class: "chip", "aria-pressed": String(est[chave].includes(v)) }, cor ? el("i", { style: { background: cor } }) : null, r);
    b.onclick = () => { const i = est[chave].indexOf(v); i >= 0 ? est[chave].splice(i, 1) : est[chave].push(v); b.setAttribute("aria-pressed", String(i < 0)); mudar(); };
    return b;
  });
  const chipsGrupo = chipsMulti(SUP_GRUPOS, "grupos");
  const chipsConta = chipsMulti(SUP_M.map(([u, n]) => [u, n, SUP_CORES[u]]), "contas");
  const ccs = [...new Set(dados.map((l) => l.centro_custo).filter(Boolean))].sort((a, b) => +a - +b);
  const selCc = el("select", {}, el("option", { value: "" }, "Todos"), ccs.map((c) => el("option", { value: c, selected: c === est.cc }, App.sup.rotCc(c))));
  const selPj = el("select");
  const encherPj = () => {
    const pjs = [...new Set(dados.filter((l) => !selCc.value || l.centro_custo === selCc.value).map((l) => l.projeto).filter(Boolean))].sort();
    App.limpar(selPj).append(el("option", { value: "" }, "Todos"), ...pjs.map((p) => el("option", { value: p, selected: p === est.pj }, App.sup.rotPj(p))));
    if (!pjs.includes(est.pj)) est.pj = "";
  };
  encherPj();
  const busca = el("input", { type: "search", placeholder: "Linha (loja, evento, área…)", value: est.q });
  const mudar = () => {
    Object.assign(est, { de: selDe.value <= selAte.value ? selDe.value : selAte.value, ate: selDe.value <= selAte.value ? selAte.value : selDe.value, cc: selCc.value, pj: selPj.value, q: busca.value });
    salvar(); desenhar();
  };
  selDe.onchange = selAte.onchange = mudar;
  selCc.onchange = () => { encherPj(); mudar(); };
  selPj.onchange = mudar;
  let tb; busca.oninput = () => { clearTimeout(tb); tb = setTimeout(mudar, 200); };
  corpo.append(App.barraPadrao({ campos: [
    App.campo("Período", el("div", { class: "presets" }, selDe, el("span", { class: "ajuda" }, "até"), selAte)),
    el("div", { class: "campo" }, el("span", {}, "Ano"), el("div", { class: "presets" }, chipsAno)),
    el("div", { class: "campo" }, el("span", {}, "Grupo (nenhum = todos)"), el("div", { class: "chips" }, chipsGrupo)),
    el("div", { class: "campo" }, el("span", {}, "Medidor (nenhum = todos)"), el("div", { class: "chips" }, chipsConta)),
    App.campo("Centro de custo", selCc), App.campo("Projeto", selPj)],
  busca, limpar: () => { try { sessionStorage.removeItem("sup_resumo"); } catch (e) { /* ok */ } App.rotear(); } }));
  const alvo = el("div");
  corpo.append(alvo);

  function desenhar() {
    App.destruirGraficos();
    App.limpar(alvo);
    const contas = est.contas.length ? est.contas : SUP_M.map(([u]) => u);
    const q = App.norm(est.q);
    const ls = dados.filter((l) => l.mes >= est.de && l.mes <= est.ate && (!est.grupos.length || est.grupos.includes(l.grupo))
      && (!est.cc || l.centro_custo === est.cc) && (!est.pj || l.projeto === est.pj) && (!q || App.norm(l.descricao).includes(q)));
    const val = (l) => App.soma(contas, (u) => l.cobrado[u] || 0);
    const meses = todos.filter((m) => m >= est.de && m <= est.ate);
    const total = App.soma(ls, val);
    const porGrupo = Object.fromEntries(SUP_GRUPOS.map(([g]) => [g, App.soma(ls.filter((l) => l.grupo === g), val)]));
    const nomeContas = contas.length === SUP_M.length ? "energia, água, gás e poço" : contas.map((u) => SUP_M.find((x) => x[0] === u)[1].toLowerCase()).join(", ");
    alvo.append(el("div", { class: "kpis" },
      App.kpi("Total cobrado no período", App.fmt.brlCurto(total), "core", `${meses.length} mês(es) · ${nomeContas}`, AJ.kpiResTotal),
      ...SUP_M.filter(([u]) => contas.includes(u)).map(([u, , c], i) => App.kpi(c, App.fmt.brlCurto(App.soma(ls, (l) => l.cobrado[u] || 0)), ["p900", "p100", "branco", "p100"][i],
        `média ${App.fmt.brlCurto(meses.length ? App.soma(ls, (l) => l.cobrado[u] || 0) / meses.length : 0)} por mês`, AJ.kpiResMed(c.toLowerCase()))),
      App.kpi("Parte da Engenharia", App.fmt.brlCurto(porGrupo.engenharia), "g200", total ? `${App.fmt.pct(100 * porGrupo.engenharia / total)} do período` : "", AJ.kpiResEng)));
    if (!ls.length) { alvo.append(el("div", { class: "cartao vazio" }, "Nada para os filtros escolhidos.")); return; }

    const g1 = G.area("grafico"), g2 = G.area("grafico"), g3 = G.area("grafico"), g4 = G.area("grafico");
    const porLinha = Object.values(App.agrupar(ls, (l) => l.descricao)).map((x) => ({ d: x[0].descricao, g: x[0].grupo, v: App.soma(x, val), n: new Set(x.map((y) => y.mes)).size }))
      .filter((x) => x.v).sort((a, b) => b.v - a.v);
    const top = porLinha.slice(0, 15);
    g4.div.style.height = Math.max(240, top.length * 34 + 60) + "px";
    const corG = Object.fromEntries(SUP_GRUPOS.map(([g, , c]) => [g, c]));
    const nomeG = Object.fromEntries(SUP_GRUPOS.map(([g, n]) => [g, n]));
    const gruposVis = SUP_GRUPOS.filter(([g]) => porGrupo[g]);
    alvo.append(el("div", { class: "grade g-12" },
      el("div", { class: "s-7" }, App.cartao("Valor de cada mês, por grupo", `valor de ${nomeContas} · cada cor é um grupo; a Parte da Engenharia é o que não foi cobrado das áreas`, G.legenda(gruposVis.map(([, n, c]) => [n, c])), g1.div)),
      el("div", { class: "s-5" }, App.cartao("Total do período por grupo", "soma de todos os meses do filtro", g2.div))),
      el("div", { class: "grade g-12", style: { marginTop: "16px" } },
        el("div", { class: "s-6" }, App.cartao("Valor de cada mês, por medidor", nomeContas, G.legenda(SUP_M.filter(([u]) => contas.includes(u)).map(([u, n]) => [n, SUP_CORES[u]])), g3.div)),
        el("div", { class: "s-6" }, App.cartao("As 15 linhas que mais pagam", "soma do período, maior valor primeiro", g4.div))));
    G.barrasEmpilhadas(g1.canvas, meses.map(supMesCurto), gruposVis.map(([g, n, c]) => ({ rotulo: n, cor: c, valores: meses.map((m) => App.soma(ls.filter((l) => l.mes === m && l.grupo === g), val)) })), { rotacao: 0 });
    G.barrasH(g2.canvas, gruposVis.map(([, n]) => n), gruposVis.map(([g]) => porGrupo[g]), gruposVis.map(([, , c]) => c),
      { tooltipExtra: (i) => ` ${App.fmt.pct(100 * porGrupo[gruposVis[i][0]] / total)} do total` });
    G.barrasEmpilhadas(g3.canvas, meses.map(supMesCurto), SUP_M.filter(([u]) => contas.includes(u)).map(([u, n]) => ({ rotulo: n, cor: SUP_CORES[u], valores: meses.map((m) => App.soma(ls.filter((l) => l.mes === m), (l) => l.cobrado[u] || 0)) })), { rotacao: 0 });
    G.barrasH(g4.canvas, top.map((x) => App.quebrar(x.d, 28)), top.map((x) => x.v), top.map((x) => corG[x.g]), { tooltipExtra: (i) => ` ${nomeG[top[i].g]} · ${top[i].n} mês(es)` });

    /* ---- tabelas */
    /* ---- mês a mês: cada mês abre a lista das linhas com R$, consumo (kWh / m³) e % de cada medidor */
    const UNM = { energia: "kWh", agua: "m³", gas: "m³", poco: "m³" };
    const medVis = SUP_M.filter(([u]) => contas.includes(u));
    const qtdTxt = (q, u) => (q || q === 0) && q !== null ? `${(+q).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} ${UNM[u]}` : "";
    const celMed = (v, q, p, u, est) => est && u === "poco" && p
      ? el("div", { class: "celula-2l sup-med", style: { alignItems: "flex-end" }, title: "Sem medição de poço: % aproximado igual ao % da água desta linha" },
        el("span", {}, "≈ " + App.fmt.brl(v)), q ? el("small", { class: "sup-calc" }, "≈ " + qtdTxt(q, u)) : null,
        el("small", { class: "sup-pct sup-pct--est" }, `${App.fmt.pct(p)} do poço · % da água sobre a sobra`))
      : el("div", { class: "celula-2l sup-med", style: { alignItems: "flex-end" } },
        el("span", {}, v ? App.fmt.brl(v) : "—"), q ? el("small", { class: "sup-calc" }, qtdTxt(q, u)) : null,
        p !== null && p !== undefined && v ? el("small", { class: "sup-pct" }, `${App.fmt.pct(p)} ${u === "poco" ? "do poço" : "da conta"}`) : null);
    const doMes = (m) => ls.filter((l) => l.mes === m);
    const mesesG = [...meses].reverse().map((m) => ({ chave: m, m }));
    const qtdMes = (m, u) => App.soma(doMes(m), (l) => (l.qtd && l.qtd[u]) || 0);
    alvo.append(el("div", { class: "secao" }, el("h3", {}, "Mês a mês")), App.cartao("Mês a mês: valor de cada medidor",
      "clique num mês para abrir as linhas (locatários, eventos, áreas e Parte da Engenharia) com valor, consumo e % de cada medidor · use o ? de cada coluna para ver o que o número representa",
      App.tabelaExpansivel([
        { rotulo: "Mês", ajuda: AJ.colMes, valor: (g) => g.m, render: (g) => el("div", { class: "celula-2l" }, el("b", {}, supMesNome(g.m)),
          el("a", { href: "#/sup/mes/" + g.m, onclick: (ev) => ev.stopPropagation() }, "abrir o rateio")) },
        ...medVis.map(([u, n]) => ({ rotulo: n, ajuda: AJ.colMesMed(u, n), num: true, valor: (g) => App.soma(doMes(g.m), (l) => l.cobrado[u] || 0),
          render: (g) => { const c = celMed(App.soma(doMes(g.m), (l) => l.cobrado[u] || 0), qtdMes(g.m, u), null, u);
            c.title = "consumo somado das linhas que têm medição (eventos do Relatório e linhas com consumo digitado)"; return c; },
          total: (gs) => App.fmt.brl(App.soma(gs, (g) => App.soma(doMes(g.m), (l) => l.cobrado[u] || 0))) })),
        { rotulo: "Total", ajuda: AJ.colMesTotal, num: true, valor: (g) => App.soma(doMes(g.m), val), render: (g) => el("b", {}, App.fmt.brl(App.soma(doMes(g.m), val))), total: () => App.fmt.brl(total) },
        { rotulo: "Linhas", ajuda: "Quantas linhas de rateio (locatários, eventos, áreas e a Parte da Engenharia) o mês tem dentro do filtro.", num: true, valor: (g) => doMes(g.m).length },
      ], mesesG, {
        filhos: (g) => doMes(g.m).filter((l) => val(l) || medVis.some(([u]) => l.qtd && l.qtd[u])),
        semLimite: true,
        colunasFilhos: [
          { rotulo: "Linha", ajuda: AJ.colLinha, valor: (l) => l.descricao, render: (l) => el("div", { class: "celula-2l" }, el("b", {}, l.descricao || "—"),
            el("small", {}, `CC ${l.centro_custo || "—"} · projeto ${l.projeto || "—"}`)) },
          { rotulo: "Grupo", ajuda: AJ.colGrupo, valor: (l) => nomeG[l.grupo], render: (l) => el("span", { class: "etiqueta", style: { background: corG[l.grupo] + "22", color: corG[l.grupo] } }, nomeG[l.grupo]) },
          ...medVis.map(([u, n]) => ({ rotulo: n, ajuda: AJ.colLinhaMed(u, n), num: true, valor: (l) => l.cobrado[u] || 0,
            render: (l) => celMed(l.cobrado[u] || 0, l.qtd && l.qtd[u], l.pct && l.pct[u], u, l.poco_estimado),
            total: (x) => App.fmt.brl(App.soma(x, (l) => l.cobrado[u] || 0)) })),
          { rotulo: "Total", ajuda: AJ.colLinhaTotal, num: true, valor: val, render: (l) => el("b", {}, App.fmt.brl(val(l))), total: (x) => App.fmt.brl(App.soma(x, val)) },
        ],
        rodape: true, vazio: "Nada para os filtros escolhidos." })));
    alvo.append(el("div", { class: "secao" }, el("h3", {}, "Por linha")), App.cartao("Total de cada linha no período", `${porLinha.length} linha(s) · ${nomeContas}`,
      App.tabela([
        { rotulo: "Linha", ajuda: AJ.colLinha, valor: (x) => x.d, render: (x) => el("b", {}, x.d) },
        { rotulo: "Grupo", ajuda: AJ.colGrupo, valor: (x) => nomeG[x.g], render: (x) => el("span", { class: "etiqueta", style: { background: corG[x.g] + "22", color: corG[x.g] } }, nomeG[x.g]) },
        ...SUP_M.filter(([u]) => contas.includes(u)).map(([u, n]) => ({ rotulo: n, ajuda: AJ.colPeriodoMed(n), num: true, valor: (x) => App.soma(ls.filter((l) => l.descricao === x.d), (l) => l.cobrado[u] || 0),
          render: (x) => App.fmt.brl(App.soma(ls.filter((l) => l.descricao === x.d), (l) => l.cobrado[u] || 0)), total: (lst) => App.fmt.brl(App.soma(lst, (x) => App.soma(ls.filter((l) => l.descricao === x.d), (l) => l.cobrado[u] || 0))) })),
        { rotulo: "Total", ajuda: "Soma dos medidores escolhidos no filtro, de todos os meses do período, para esta linha. É o valor cobrado (já com desconto), não o valor das notas.", num: true, valor: (x) => x.v, render: (x) => el("b", {}, App.fmt.brl(x.v)), total: (lst) => App.fmt.brl(App.soma(lst, (x) => x.v)) },
        { rotulo: "Meses", ajuda: "Em quantos meses do período esta linha aparece no rateio.", num: true, valor: (x) => x.n },
      ], porLinha, { rodape: true, ordem: { i: 2 + contas.length, dir: -1 } })));
  }
  desenhar();
}

/* ------------------------------------------------------------------ CONFIGURAÇÕES */
function supConfig(corpo) {
  const C = App.sup.base.config;
  const ccEng = supSeletor("cc", C.cc_engenharia), pjEng = supSeletor("pj", C.projeto_engenharia);
  const campo = (k, rot, ajuda) => { const i = el("input", { type: "text", value: C[k] || "" }); i.dataset.k = k; return el("label", { class: "campo" }, el("span", {}, rot), i, ajuda ? el("small", {}, ajuda) : null); };
  const campos = [
    campo("agente_energia", "Agente · energia elétrica", "ex.: 7001"), campo("agente_agua", "Agente · água", "ex.: 7002"),
    campo("agente_gas", "Agente · gás", "ex.: 7003"), campo("organizacao", "Organização"), campo("filial", "Filial"), campo("acao", "Ação")];
  corpo.append(App.cartao("Centro de custo e projeto da Engenharia", "quem fica com a Parte da Engenharia de cada conta (o que não é cobrado das áreas)",
      el("div", { class: "grade-form", style: { gridTemplateColumns: "1fr 1fr" } }, App.campo("Centro de custo", ccEng.el), App.campo("Projeto", pjEng.el))),
    el("div", { style: { height: "16px" } }),
    App.cartao("Centro de custo dos eventos", "centro de custo de cada tipo de evento: usado nas linhas trazidas do Relatório de eventos e nos filtros do resumo (o resto é Locatários e áreas)",
      el("div", { class: "grade-form" }, campo("cc_show", "Shows", "nº do centro de custo"), campo("cc_jogo", "Jogos", "nº do centro de custo"),
        campo("cc_projeto_especial", "Projetos especiais", "nº do centro de custo"))),
    el("div", { style: { height: "16px" } }),
    App.cartao("Poço artesiano nos meses novos", "coluna própria no rateio ou somado à conta de água (como Enel + Esfera na energia)",
      el("div", { class: "grade-form" }, (() => {
        const s = el("select", {}, el("option", { value: "1" }, "Coluna própria (poço separado da água)"), el("option", { value: "0" }, "Somado à água (sem coluna de poço)"));
        s.value = C.poco_separado || "1"; s.dataset.k = "poco_separado";
        return el("label", { class: "campo campo--largo" }, el("span", {}, "Ao criar um mês"), s,
          el("small", {}, "Vale para os meses criados daqui em diante. Em cada mês dá para mudar no botão “Colunas” da tabela de rateio (marcar / desmarcar Poço artesiano)."));
      })())),
    el("div", { style: { height: "16px" } }),
    App.cartao("Planilha de importação do Suprimentos", "códigos fixos do cabeçalho do documento (o código do item, aplicação, tipo de classe e CFOP saem do agente)",
      el("div", { class: "grade-form" }, campos)),
    el("div", { style: { height: "16px" } }),
    App.cartao("Como calcular a tarifa", "como o valor de cada linha com consumo é calculado (consumo × tarifa)",
      el("div", { class: "grade-form" }, (() => {
        const s = el("select", {}, el("option", { value: "1" }, "Conta do mês anterior (como na planilha de consumos)"), el("option", { value: "0" }, "Conta do mesmo mês"));
        s.value = C.tarifa_mes_anterior || "1"; s.dataset.k = "tarifa_mes_anterior";
        const c = el("label", { class: "campo campo--largo" }, el("span", {}, "Tarifa usada no mês"), s,
          el("small", {}, "Tarifa = valor da fatura ÷ consumo da conta. Ex.: a leitura de setembro usa a fatura de agosto. Importe a planilha de consumos (abas Supri...) ou digite a tarifa no card “Tarifa do mês”, na tela Rateio do mês."));
        return c; })())),
    el("div", { style: { height: "16px" } }),
    App.cartao("GateX (medição de energia)", "de onde o botão “Puxar consumo do GateX” lê o consumo dos locatários e dos eventos",
      el("div", { class: "grade-form" }, (() => { const c = campo("gatex_link", "Link do GateX",
        "Abra o GateX no navegador, copie o endereço da página (com o ?sid=...) e cole aqui. Quando a sessão do GateX expirar, cole o link novo. O computador do site precisa estar na rede da empresa ou na VPN."); c.classList.add("campo--largo"); return c; })())),
    el("div", { class: "linha-acoes" }, App.btnEditor("Salvar configurações", async () => {
      const d = { cc_engenharia: ccEng.value, projeto_engenharia: pjEng.value };
      corpo.querySelectorAll("input[data-k], select[data-k]").forEach((i) => (d[i.dataset.k] = i.value));
      try { await App.api("/api/sup/config", { method: "POST", json: d }); App.toast("Configurações salvas."); } catch (e) { App.toast(e.message, true); }
    }, "btn")));
}
