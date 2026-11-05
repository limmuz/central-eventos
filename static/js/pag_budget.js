/* Área: Budget (Budget por ano, Pedidos, Cadastros). Realocações de verba não entram mais na conta.
   Gasto = medições de NF + pedidos ligados à classe financeira (pelo mês da data). */
"use strict";

App.bud = { base: null };
const BUD_CORES = { med: "#6A0BB0", ped: "#4F8F33", real: "#A876F0", prev: "#C9E2BF", alerta: "#B42318" };
const MESES_CURTOS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const MESES_LONGOS = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
const budNomeMes = (k, longo) => { const [a, m] = k.split("-"); return longo ? `${MESES_LONGOS[+m - 1]} de ${a}` : `${MESES_CURTOS[+m - 1]}/${a.slice(2)}`; };
/* Centro de custo e projeto = Nº + descrição (a descrição vem dos Cadastros) */
App.bud.desc = { cc: {}, pj: {} };
App.bud.rotCc = (c) => (c ? (App.bud.desc.cc[c] ? `${c} — ${App.bud.desc.cc[c]}` : c) : "");
App.bud.rotPj = (p) => (p ? (App.bud.desc.pj[p] ? `${p} — ${App.bud.desc.pj[p]}` : p) : "");
App.bud.nomeItem = (i) => i ? `${i.classe_numero} ${i.classe_descricao || ""} · ${App.bud.rotPj(i.projeto) || "sem projeto"}${i.centro_custo ? " · " + App.bud.rotCc(i.centro_custo) : ""}` : "—";
/** Célula com Nº em negrito e descrição embaixo. */
App.bud.celulaCod = (cod, desc) => cod ? el("div", { class: "celula-2l" }, el("b", {}, cod), desc ? el("small", {}, desc) : null) : "—";

App.bud.carregarBase = async function () {
  App.bud.base = await App.api("/api/budget/base");
  const C = App.bud.base.cadastros;
  App.bud.desc = { cc: Object.fromEntries(C.centros.map((c) => [c.nome, c.descricao || ""])), pj: Object.fromEntries(C.projetos.map((p) => [p.nome, p.descricao || ""])) };
  return App.bud.base;
};

/** Seletor de classe financeira (linha do budget) com busca. */
App.bud.seletorItem = function (valor, { vazio = "Sem classe financeira", itens = null } = {}) {
  const lista = itens || App.bud.base.itens;
  return el("select", {}, el("option", { value: "" }, vazio),
    lista.map((i) => el("option", { value: i.id, selected: +valor === i.id }, App.bud.nomeItem(i))));
};

/** Situação de centro de custo + projeto + classe no budget do ano: {ok, texto} (null se não tem classe). */
App.bud.situacao = function (cc, pj, cl, ano) {
  const B = App.bud.base;
  if (!cl) return null;
  const a = String(ano || new Date().getFullYear());
  const it = B.itens.find((i) => i.centro_custo === cc && i.projeto === pj && i.classe_numero === cl);
  const ok = !!it && (B.no_budget[a] || []).includes(it.id);
  const nome = `${App.bud.rotCc(cc) || "sem centro de custo"} · ${App.bud.rotPj(pj) || "sem projeto"} · ${cl}`;
  return { ok, texto: ok ? `${nome} está no budget de ${a}` : `${nome} não está no budget de ${a} — o valor não está sendo calculado.` };
};
App.bud.aviso = (sit) => (sit ? el("div", { class: "aviso-budget " + (sit.ok ? "aviso-budget--ok" : "aviso-budget--alerta") }, sit.texto) : null);
App.bud.linkCadastros = () => el("a", { href: "#/budget/cadastros", "data-fechar": "", class: "link-cadastros" }, "Não está na lista? Cadastre em Meu perfil › Configurações › Budget →");

/** Listas suspensas de centro de custo, projeto (filtrado pelo centro de custo) e classe financeira, vindas dos Cadastros.
    ano(): ano usado no aviso "não está no budget". */
App.bud.camposClasse = function (v = {}, { ano = null, vazio = "—", semAviso = false, aoMudar = null } = {}) {
  const C = App.bud.base.cadastros;
  const cc = el("select"), pj = el("select"), cl = el("select");
  const encher = (sel, lista, todos, atual) => {
    App.limpar(sel).append(el("option", { value: "" }, vazio));
    lista.forEach((x) => sel.append(el("option", { value: x.v, selected: x.v === atual }, x.r)));
    if (atual && !todos.includes(atual)) sel.append(el("option", { value: atual, selected: true }, atual + " (não cadastrado)"));
    if (atual && todos.includes(atual) && !lista.some((x) => x.v === atual)) sel.value = "";   // projeto de outro centro de custo
  };
  const projetos = () => C.projetos.filter((p) => !p.centro_custo || !cc.value || p.centro_custo === cc.value).map((p) => ({ v: p.nome, r: App.bud.rotPj(p.nome) }));
  encher(cc, C.centros.map((c) => ({ v: c.nome, r: App.bud.rotCc(c.nome) })), C.centros.map((c) => c.nome), v.centro_custo || "");
  encher(pj, projetos(), C.projetos.map((p) => p.nome), v.projeto || "");
  encher(cl, C.classes.map((c) => ({ v: c.numero, r: `${c.numero} — ${c.descricao || "sem descrição"}` })), C.classes.map((c) => c.numero), v.classe_numero || "");
  const aviso = el("div", { class: "aviso-budget-slot" });
  const checar = () => {
    App.limpar(aviso);
    if (!semAviso) aviso.append(App.bud.aviso(App.bud.situacao(cc.value, pj.value, cl.value, ano && ano())) || "");
    if (aoMudar) aoMudar();
  };
  const ccDoProjeto = () => {   // projeto com centro de custo cadastrado: puxa o centro de custo
    const p = C.projetos.find((x) => x.nome === pj.value);
    if (p && p.centro_custo && cc.value !== p.centro_custo) {
      encher(cc, C.centros.map((c) => ({ v: c.nome, r: App.bud.rotCc(c.nome) })), C.centros.map((c) => c.nome), p.centro_custo);
      encher(pj, projetos(), C.projetos.map((x) => x.nome), p.nome);
    }
  };
  if (v.projeto && !v.centro_custo) ccDoProjeto();
  cc.onchange = () => { encher(pj, projetos(), C.projetos.map((p) => p.nome), pj.value); checar(); };
  pj.onchange = () => { ccDoProjeto(); checar(); };
  cl.onchange = checar;
  checar();
  const lab = (t, sel) => el("label", { class: "campo" }, el("span", {}, t), sel);
  return {
    cc, pj, cl, aviso, checar,
    valores: () => ({ centro_custo: cc.value, projeto: pj.value, classe_numero: cl.value }),
    campos: () => [lab("Centro de custo", cc), lab("Projeto", pj), lab("Classe financeira", cl)],
  };
};

/** Rateio de uma NF ou de um pedido entre várias linhas do budget (centro de custo + projeto + classe financeira),
    por percentual ou digitando o valor de cada parte. total(): valor a ratear. ano(): ano do aviso "não está no budget".
    Devolve { bloco, ativo(), validar(), dados(), aoTrocar(fn) }. */
App.bud.rateio = function (iniciais = [], { total, ano = null, titulo = "Ratear entre centros de custo / classes financeiras", base = "valor da NF" } = {}) {
  const fmtN = (v) => (Math.round(v * 100) / 100).toFixed(2);
  const ativo = el("input", { type: "checkbox", checked: iniciais.length > 1, style: { width: "auto", margin: 0 } });
  let modo = iniciais.length > 1 && iniciais.every((l) => l.valor != null) ? "valor" : "pct";
  let aoTrocar = () => {};
  const linhas = [];
  const lista = el("div", { class: "rateio__linhas" });
  const totalTxt = el("div", { class: "rateio__total", role: "status", "aria-live": "polite" });
  const chips = [["pct", "Por %"], ["valor", "Por valor (R$)"]].map(([k, r]) => {
    const b = el("button", { class: "chip chip--mini", type: "button", "aria-pressed": String(modo === k) }, r);
    b.onclick = () => trocarModo(k);
    return b;
  });
  const soma = () => App.soma(linhas, (l) => +l.num.value || 0);
  function atualizar() {
    const T = +total() || 0;
    linhas.forEach((l, i) => {
      const v = +l.num.value || 0;
      l.rot.textContent = modo === "pct" ? "Percentual (%)" : "Valor (R$)";
      l.parte.textContent = modo === "pct" ? (T ? `= ${App.fmt.brl(T * v / 100)}` : "") : (T ? `= ${App.fmt.pct(100 * v / T)}` : "");
      l.rem.disabled = linhas.length <= 2;
      l.n.textContent = `Parte ${i + 1}`;
    });
    const s = soma();
    const alvo = modo === "pct" ? 100 : T;
    const falta = Math.round((alvo - s) * 100) / 100;
    const ok = Math.abs(falta) <= 0.01;
    totalTxt.className = "rateio__total " + (ok ? "rateio__total--ok" : "rateio__total--falta");
    totalTxt.textContent = modo === "pct"
      ? `Soma: ${App.fmt.pct(s)}${ok ? " — fecha 100%" : falta > 0 ? ` — faltam ${App.fmt.pct(falta)}` : ` — passou ${App.fmt.pct(-falta)}`}`
      : `Soma: ${App.fmt.brl(s)} de ${App.fmt.brl(T)}${ok ? " — fecha o total" : falta > 0 ? ` — faltam ${App.fmt.brl(falta)}` : ` — passou ${App.fmt.brl(-falta)}`}`;
    aoTrocar();
  }
  function nova(v = {}, valorIni = "") {
    const cps = App.bud.camposClasse(v, { ano, vazio: "—", aoMudar: () => aoTrocar() });
    const num = el("input", { type: "number", step: "0.01", min: "0", value: valorIni });
    const rot = el("span"), parte = el("small", { class: "rateio__parte" }), n = el("b", { class: "rateio__n" });
    const rem = el("button", { class: "btn btn--mini btn--linha", type: "button", title: "Tirar esta parte", "aria-label": "Tirar esta parte" }, "✕");
    const l = { cps, num, rot, parte, rem, n };
    l.dom = el("div", { class: "rateio__linha" }, n, el("div", { class: "grade-form" }, cps.campos(), el("label", { class: "campo" }, rot, num, parte), el("div", { class: "campo rateio__acao" }, rem)), cps.aviso);
    num.addEventListener("input", atualizar);
    rem.onclick = () => { if (linhas.length <= 2) return; linhas.splice(linhas.indexOf(l), 1); l.dom.remove(); atualizar(); };
    linhas.push(l);
    lista.append(l.dom);
    return l;
  }
  function trocarModo(k) {
    if (k === modo) return;
    const T = +total() || 0;
    linhas.forEach((l) => {   // converte o que já foi digitado
      const v = +l.num.value || 0;
      if (!l.num.value) return;
      l.num.value = k === "valor" ? (T ? fmtN(T * v / 100) : "") : (T ? fmtN(100 * v / T) : "");
    });
    modo = k;
    chips.forEach((b, i) => b.setAttribute("aria-pressed", String(["pct", "valor"][i] === k)));
    atualizar();
  }
  const T0 = +total() || 0;
  if (iniciais.length > 1) iniciais.forEach((x) => nova(x, modo === "valor" ? fmtN(T0 * x.pct / 100) : fmtN(x.pct)));
  else { nova(iniciais[0] || {}, ""); nova({}, ""); }
  const adicionar = el("button", { class: "btn btn--mini btn--linha", type: "button", onclick: () => { nova(); atualizar(); linhas[linhas.length - 1].cps.cc.focus(); } }, "+ Adicionar parte");
  const dividir = el("button", { class: "btn btn--mini btn--linha", type: "button", title: "Divide igualmente entre as partes",
    onclick: () => {
      const T = +total() || 0, n = linhas.length;
      const alvo = modo === "pct" ? 100 : T;
      const cada = Math.floor((alvo / n) * 100) / 100;
      linhas.forEach((l, i) => (l.num.value = fmtN(i === n - 1 ? alvo - cada * (n - 1) : cada)));
      atualizar();
    } }, "Dividir igualmente");
  const painel = el("div", { class: "rateio", hidden: !ativo.checked },
    el("div", { class: "rateio__topo" }, el("span", { class: "ajuda" }, `Cada parte vai para a sua linha do budget. Base: ${base}.`), el("div", { class: "chips" }, chips)),
    lista, el("div", { class: "rateio__rodape" }, el("div", { class: "linha-acoes", style: { margin: 0 } }, adicionar, dividir), totalTxt));
  ativo.onchange = () => { painel.hidden = !ativo.checked; atualizar(); };
  atualizar();
  const bloco = el("div", { class: "rateio-bloco" },
    el("label", { class: "rateio__liga" }, ativo, titulo), painel);
  return {
    bloco, painel,
    ativo: () => ativo.checked,
    atualizar,
    aoTrocar: (fn) => { aoTrocar = fn; },
    validar: () => {
      if (!ativo.checked) return null;
      if (linhas.some((l) => !l.cps.cl.value)) return "Rateio: escolha a classe financeira de todas as partes.";
      if (linhas.some((l) => !(+l.num.value > 0))) return `Rateio: preencha o ${modo === "pct" ? "%" : "valor"} de todas as partes.`;
      const T = +total() || 0;
      if (modo === "valor" && !T) return "Rateio por valor: preencha o valor total primeiro.";
      const alvo = modo === "pct" ? 100 : T;
      if (Math.abs(soma() - alvo) > 0.01) return modo === "pct" ? "Rateio: os percentuais precisam somar 100%." : `Rateio: as partes precisam somar ${App.fmt.brl(T)}.`;
      return null;
    },
    dados: () => ({ modo, linhas: ativo.checked ? linhas.map((l) => ({ ...l.cps.valores(), [modo === "pct" ? "pct" : "valor"]: l.num.value })) : [] }),
  };
};
/** Grava o rateio (lista vazia = tira o rateio). */
App.bud.salvarRateio = (tipo, id, r) => App.api("/api/budget/rateio", { method: "POST", json: { tipo, id, ...r.dados() } });

/* Botões de Excel usados nas páginas do budget: exportar a página + planilha única de importação */
function budBotoesExcel(tipo, ano) {
  const rot = { budget: `Budget${ano ? " " + ano : ""}`, pedidos: `Pedidos de compra${ano ? " " + ano : ""}`, cadastros: "Cadastros (centros de custo, projetos e classes)" }[tipo] || "Budget";
  App.exportarExcel = { rotulo: rot, url: `/api/budget/exportar?tipo=${tipo}${ano ? "&ano=" + ano : ""}` };   // vai no botão "Exportar"
  return [...App.importacao.botoes()];
}

App.paginas.budget = async function (raiz, params) {
  if (params[0] === "pedidos") { location.replace("#/nf/pedidos"); return; }   // Pedidos agora ficam em Notas fiscais
  const sub = params[0] === "cadastros" ? "cadastros" : "budget";
  try { await App.bud.carregarBase(); } catch (e) { raiz.append(el("div", { class: "cartao vazio" }, e.message)); return; }
  await ({ budget: budBudget, pedidos: budPedidos, cadastros: budCadastros })[sub](raiz, params);
};

/* ------------------------------------------------------------------ BUDGET */
/* Valores de cada linha (classe financeira de um projeto / centro de custo):
   Solicitado = pedido pela gestora · Aprovado = aprovado pela controladoria · Gasto = medições + pedidos.
   Saldo e % executado são sempre sobre o aprovado (linha sem aprovado fica sem saldo). */
/* Saldo e % executado são sempre sobre o APROVADO. Linha ainda sem aprovado não tem saldo (aparece "sem aprovado"). */
const budBase = (l) => (l.aprovado ?? 0);
const budRecalc = (l) => {
  const base = budBase(l);
  l.previsto = base;
  l.saldo = l.aprovado == null ? null : base - l.gasto;
  l.pct = l.aprovado ? Math.round(1000 * l.gasto / l.aprovado) / 10 : null;
  l.pct_solicitado = l.solicitado ? Math.round(1000 * l.gasto / l.solicitado) / 10 : null;
  l.corte = l.aprovado != null && l.solicitado != null ? l.aprovado - l.solicitado : null;
  return l;
};
const budPct = (v) => v === null || v === undefined ? "—" : el("div", { class: "barra-pct" },
  el("b", { class: "trilho" }, el("i", { style: { width: Math.min(100, v) + "%", background: v > 100 ? BUD_CORES.alerta : v > 85 ? BUD_CORES.med : "#4F8F33" } })), el("span", {}, App.fmt.pct(v)));

async function budBudget(raiz) {
  const B = App.bud.base;
  const anoAtual = new Date().getFullYear();
  let ano = +(sessionStorage.getItem("bud_ano") || 0) || (B.anos.includes(anoAtual) ? anoAtual : B.anos[0] || anoAtual);
  const est = { cc: "", projeto: "", q: "", origem: "", mostrar: "", fechados: [] };
  try { Object.assign(est, JSON.parse(sessionStorage.getItem("bud_filtro") || "{}")); } catch (e) { /* ok */ }
  const salvar = () => { try { sessionStorage.setItem("bud_filtro", JSON.stringify(est)); } catch (e) { /* ok */ } };
  const anos = [...new Set([...B.anos, ano])].sort((a, b) => b - a);

  raiz.append(el("div", { class: "pagina-cabecalho" },
    el("div", {}, el("h2", {}, `Budget ${ano}`), el("p", {}, "Solicitado (gestora) × aprovado (controladoria) × incorrido (medições de NF + pedidos), por projeto, centro de custo e classe financeira")),
    el("div", { class: "acoes" }, budBotoesExcel("budget", ano),
      App.btnEditor("Lançar solicitado e aprovado", () => budLancarPrevistos(ano), "btn btn--sec"),
      App.btnEditor("+ Nova linha", () => budEditarLinha({ ano }), "btn"))));
  const chipsAno = anos.map((a) => { const b = el("button", { class: "chip", "aria-pressed": String(a === ano) }, String(a)); b.onclick = () => { sessionStorage.setItem("bud_ano", a); App.rotear(); }; return b; });
  const faixa = el("div");
  const filtros = el("div");
  const alvo = el("div");
  raiz.append(faixa, filtros, alvo);
  const [dados, fora, lanc] = await Promise.all([App.api(`/api/budget/ano/${ano}`), App.api(`/api/budget/fora?ano=${ano}`), App.api(`/api/budget/lancamentos?ano=${ano}`)]);
  faixa.append(budFaixaFora(fora, ano) || "");

  /* filtros (valem para os números, os gráficos e as tabelas) */
  const selCc = el("select", {}, el("option", { value: "" }, "Todos"), B.centros.map((c) => el("option", { value: c, selected: c === est.cc }, App.bud.rotCc(c) || "(sem centro de custo)")));
  const selProj = el("select", {}, el("option", { value: "" }, "Todos"), B.projetos.map((c) => el("option", { value: c, selected: c === est.projeto }, App.bud.rotPj(c) || "(sem projeto)")));
  const selMostrar = el("select", {}, [["", "Todas as linhas"], ["estouradas", "Só estouradas (incorrido > aprovado)"], ["sem_aprovado", "Sem aprovado"], ["sem_solicitado", "Sem solicitado"], ["com_corte", "Aprovado menor que o solicitado"]]
    .map(([v, r]) => el("option", { value: v, selected: v === est.mostrar }, r)));
  const busca = el("input", { type: "search", placeholder: "Classe, descrição, projeto…", value: est.q });
  selCc.onchange = () => { est.cc = selCc.value; salvar(); desenhar(); };
  selProj.onchange = () => { est.projeto = selProj.value; salvar(); desenhar(); };
  selMostrar.onchange = () => { est.mostrar = selMostrar.value; salvar(); desenhar(); };
  let tb; busca.oninput = () => { clearTimeout(tb); tb = setTimeout(() => { est.q = busca.value; salvar(); desenhar(); }, 150); };
  const chipsOrigem = [["", "Tudo"], ["medicoes", "Só medições (NF e contas de consumo)"], ["pedidos", "Só pedidos"]].map(([v, r]) => {
    const b = el("button", { class: "chip", "aria-pressed": String(est.origem === v) }, r);
    b.onclick = () => { est.origem = v; salvar(); chipsOrigem.forEach((x) => x.setAttribute("aria-pressed", String(x === b))); desenhar(); };
    return b;
  });
  filtros.append(App.barraPadrao({ campos: [
    el("div", { class: "campo" }, el("span", {}, "Ano"), el("div", { class: "chips" }, chipsAno,
      App.btnEditor("+ Novo ano", () => budNovoAno(anos), "chip chip--mini"),
      B.anos.includes(ano) ? App.btnEditor("Excluir ano", () => budExcluirAno(ano), "chip chip--mini") : null)),
    App.campo("Projeto", selProj),
    App.campo("Centro de custo", selCc),
    App.campo("Mostrar", selMostrar),
    el("div", { class: "campo" }, el("span", {}, "Incorrido vindo de"), el("div", { class: "chips" }, chipsOrigem))],
  busca, limpar: () => { Object.assign(est, { cc: "", projeto: "", q: "", origem: "", mostrar: "" }); salvar(); App.rotear(); } }));

  dados.linhas.forEach(budRecalc);

  function filtradas() {
    const q = App.norm(est.q);
    const so = (l0) => {
      if (!est.origem) return l0;
      const g = (x) => (est.origem === "medicoes" ? x.medicoes : x.pedidos);
      const zera = est.origem === "medicoes" ? { pedidos: 0 } : { medicoes: 0 };
      return budRecalc({ ...l0, ...zera, gasto: g(l0), meses: l0.meses.map((m) => ({ ...m, ...zera, gasto: g(m) })).filter((m) => m.gasto), origem: est.origem, _orig: l0 });
    };
    const passa = (l) => ({ estouradas: l.saldo != null && l.saldo < 0, sem_aprovado: l.aprovado == null, sem_solicitado: l.solicitado == null, com_corte: (l.corte ?? 0) < 0 })[est.mostrar] ?? true;
    return dados.linhas.filter((l) => (!est.cc || l.centro_custo === est.cc) && (!est.projeto || l.projeto === est.projeto) &&
      (!q || App.norm(`${l.classe_numero} ${l.classe_descricao} ${App.bud.rotPj(l.projeto)} ${App.bud.rotCc(l.centro_custo)}`).includes(q))).map(so).filter(passa);
  }

  /* grava um valor digitado direto na tabela */
  const gravar = async (l, campo, valor) => {
    const orig = l._orig || l;
    const v = valor === "" ? (orig[campo] == null ? null : "-") : valor;
    if (v === null) return;
    await App.api("/api/budget/previstos", { method: "POST", json: { ano, valores: [{ item_id: orig.item_id, [campo]: v }] } });
    orig[campo] = valor === "" ? null : +valor;
    budRecalc(orig);
    App.toast(`${campo === "aprovado" ? "Aprovado" : "Solicitado"} salvo: classe ${orig.classe_numero}, projeto ${orig.projeto || "—"}.`);
    desenhar();
  };

  function desenhar() {
    App.destruirGraficos();
    App.limpar(alvo);
    const linhas = filtradas();
    if (!dados.linhas.length) {
      alvo.append(el("div", { class: "cartao vazio" }, `Nenhuma linha no budget de ${ano}. Use “Lançar solicitado e aprovado”, “+ Nova linha” ou a guia BUDGET da planilha de importação.`));
      return;
    }
    const S = (f) => App.soma(linhas, (l) => f(l) || 0);
    const sol = S((l) => l.solicitado), apr = S((l) => l.aprovado), gasto = S((l) => l.gasto);
    const comApr = linhas.filter((l) => l.aprovado != null), gastoComApr = App.soma(comApr, (l) => l.gasto), gastoSemApr = gasto - gastoComApr;
    const estouradas = linhas.filter((l) => l.saldo != null && l.saldo < 0).length;
    const semApr = linhas.filter((l) => l.aprovado == null).length;
    alvo.append(el("div", { class: "kpis" },
      App.kpi("Solicitado", App.fmt.brlCurto(sol), "p100", `pedido pela gestora · ${linhas.filter((l) => l.solicitado != null).length} de ${linhas.length} linha(s)`),
      App.kpi("Aprovado", App.fmt.brlCurto(apr), "core", sol ? `${apr - sol < 0 ? "corte de " + App.fmt.brlCurto(sol - apr) : "+ " + App.fmt.brlCurto(apr - sol)} (${App.fmt.pct(100 * apr / sol)} do solicitado)`
        + (semApr ? ` · ${semApr} sem aprovado` : "") : (semApr ? `${semApr} linha(s) sem aprovado` : "pela controladoria")),
      App.kpi("Incorrido", App.fmt.brlCurto(gasto), "p900", `medições ${App.fmt.brlCurto(S((l) => l.medicoes))}${S((l) => l.consumo || 0) ? ` (contas de consumo ${App.fmt.brlCurto(S((l) => l.consumo || 0))})` : ""} · pedidos ${App.fmt.brlCurto(S((l) => l.pedidos))}`),
      App.kpi("Saldo do aprovado", App.fmt.brlCurto(apr - gastoComApr), apr - gastoComApr < 0 ? "p900" : "g200",
        `aprovado − incorrido · ${App.fmt.pct(apr ? 100 * gastoComApr / apr : null)} usado` + (estouradas ? ` · ${estouradas} linha(s) estourada(s)` : "")
        + (gastoSemApr ? ` · + ${App.fmt.brlCurto(gastoSemApr)} incorrido em linhas sem aprovado` : ""))));
    if (!linhas.length) { alvo.append(el("div", { class: "cartao vazio" }, "Nenhuma linha para os filtros escolhidos.")); return; }
    const ids = new Set(linhas.map((l) => l.item_id));
    const lancs = lanc.filter((x) => ids.has(x.item_id) && (!est.origem || (est.origem === "medicoes" ? x.tipo !== "PEDIDO" : x.tipo === "PEDIDO")));
    budGraficos(alvo, linhas, lancs, ano);
    alvo.append(el("div", { class: "secao" }, el("h3", {}, "Linhas do budget"), el("p", {}, "Solicitado e aprovado podem ser digitados direto na tabela")),
      budTabelaProjetos(linhas, ano, est, salvar, gravar));
  }
  desenhar();
}

/** Tabela agrupada por projeto. Solicitado e aprovado são editados direto na célula (Enter ou sair do campo grava). */
function budTabelaProjetos(linhas, ano, est, salvar, gravar) {
  const editavel = App.meta.editavel;
  const cols = ["", "Classe financeira", "Solicitado", "Aprovado", "Aprovado − solicitado", "Incorrido", "Saldo do aprovado", "% do aprovado", ""];
  const NUM = [2, 3, 4, 5, 6, 7];
  const tbody = el("tbody");
  const celValor = (l, campo) => {
    const v = l[campo];
    if (!editavel) return el("td", { class: "num" }, v == null ? el("span", { class: "ajuda" }, "—") : App.fmt.brl(v));
    /* mostra 159.048,80; ao clicar vira número editável (aceita 159048,8 ou 159.048,80) */
    const bonito = (x) => x == null ? "" : x.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const cru = (x) => x == null ? "" : String(x).replace(".", ",");
    const ler = (t) => { t = t.trim().replace(/[R$\s]/g, ""); if (!t) return ""; if (t.includes(",")) t = t.replace(/\./g, "").replace(",", "."); return isNaN(+t) ? NaN : String(+t); };
    const inp = el("input", { type: "text", inputmode: "decimal", value: bonito(v), placeholder: "—", class: "cel-edit",
      title: `Digite o ${campo} desta linha e aperte Enter (vazio apaga)` });
    let cancelou = false;
    inp.addEventListener("focus", () => { inp.value = cru(v); inp.select(); });
    const enviar = () => {
      const novo = ler(inp.value);
      if (cancelou || Number.isNaN(novo) || (novo === "" && v == null) || (novo !== "" && v != null && +novo === v)) {
        if (Number.isNaN(novo)) App.toast("Valor inválido: use só números (ex.: 150000,50).", true);
        cancelou = false; inp.value = bonito(v); return;
      }
      gravar(l, campo, novo).catch((e) => { App.toast(e.message, true); inp.value = bonito(v); });
    };
    inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); inp.blur(); } if (ev.key === "Escape") { cancelou = true; inp.blur(); } });
    inp.addEventListener("blur", enviar);
    inp.addEventListener("click", (ev) => ev.stopPropagation());
    return el("td", { class: "num cel-edit-td" + (v == null ? " cel-vazia" : "") }, inp);
  };
  const corte = (c) => c == null ? el("span", { class: "ajuda" }, "—") : el("span", { style: { color: c < 0 ? "var(--perigo)" : c > 0 ? "#23511A" : "" } }, (c > 0 ? "+ " : c < 0 ? "− " : "") + App.fmt.brl(Math.abs(c)));
  const grupos = App.agrupar(linhas, (l) => l.projeto || "");
  const ordem = Object.keys(grupos).sort();
  for (const pj of ordem) {
    const ls = grupos[pj].sort((a, b) => (a.centro_custo + a.classe_numero).localeCompare(b.centro_custo + b.classe_numero));
    const T = (f) => App.soma(ls, (l) => f(l) || 0);
    const fechado = (est.fechados || []).includes(pj);
    const setaG = el("span", { class: "arvore-seta" }, fechado ? "▸" : "▾");
    const baseG = T((l) => l.aprovado), gastoG = T((l) => l.gasto), gastoGA = App.soma(ls.filter((l) => l.aprovado != null), (l) => l.gasto);
    const cab = el("tr", { class: "grupo-projeto clicavel", title: "Clique para recolher / abrir o projeto" },
      el("td", {}, setaG),
      el("td", {}, el("div", { class: "celula-2l" }, el("b", {}, `Projeto ${pj || "—"}`), el("small", {}, App.bud.desc.pj[pj] || ""))),
      el("td", { class: "num" }, App.fmt.brl(T((l) => l.solicitado))), el("td", { class: "num" }, App.fmt.brl(T((l) => l.aprovado))),
      el("td", { class: "num" }, corte(ls.some((l) => l.corte != null) ? T((l) => l.corte) : null)),
      el("td", { class: "num" }, App.fmt.brl(gastoG)),
      el("td", { class: "num", style: { color: baseG - gastoGA < 0 ? "var(--perigo)" : "" } }, App.fmt.brl(baseG - gastoGA)),
      el("td", { class: "num" }, budPct(baseG ? Math.round(1000 * gastoGA / baseG) / 10 : null)),
      el("td", { class: "ajuda" }, `${ls.length} classe(s)`));
    tbody.append(cab);
    const linhasTr = [];
    for (const l of ls) {
      const seta = el("span", { class: "arvore-seta" }, "▸");
      const tr = el("tr", { class: "arvore-n1 linha-classe", hidden: fechado },
        el("td", { class: "clicavel", title: "Ver os meses" }, seta),
        el("td", { class: "clicavel", title: "Ver os meses" }, el("div", { class: "celula-2l" }, el("b", {}, l.classe_numero), el("small", {}, (l.classe_descricao || "") + (l.centro_custo ? ` · CC ${App.bud.rotCc(l.centro_custo)}` : "")))),
        celValor(l, "solicitado"), celValor(l, "aprovado"),
        el("td", { class: "num" }, corte(l.corte)),
        el("td", { class: "num" }, el("b", {}, App.fmt.brl(l.gasto))),
        el("td", { class: "num", style: { color: l.saldo < 0 ? "var(--perigo)" : "" } }, l.saldo == null ? el("span", { class: "etiqueta" }, "sem aprovado") : el("b", {}, App.fmt.brl(l.saldo))),
        el("td", { class: "num" }, budPct(l.pct)),
        el("td", {}, el("div", { style: { display: "flex", gap: "4px" } },
          App.btnEditor("Editar", () => budEditarLinha({ ...(l._orig || l), ano }), "btn btn--mini btn--linha"),
          App.btnEditor("Tirar", () => budTirarLinha(l, ano), "btn btn--mini btn--linha"))));
      linhasTr.push(tr);
      let filhos = [];
      const abrir = () => {
        if (filhos.length) { filhos.forEach((f) => f.remove()); filhos = []; seta.textContent = "▸"; return; }
        seta.textContent = "▾";
        if (!l.meses.length) { const v = el("tr", { class: "arvore-n2" }, el("td"), el("td", { colspan: cols.length - 1, class: "ajuda" }, "Nada incorrido nesta linha em " + ano + ".")); tr.after(v); filhos = [v]; return; }
        const head = el("tr", { class: "arvore-n2 arvore-cab" }, el("td"), el("td", {}, "Mês"), el("td", { class: "num" }, "Medições"), el("td", { class: "num" }, "Pedidos"),
          el("td"), el("td", { class: "num" }, "Incorrido no mês"), el("td", { colspan: 3 }));
        let ultimo = head; tr.after(head); filhos = [head];
        for (const m of l.meses) {
          const s2 = el("span", { class: "arvore-seta" }, "▸");
          const tm = el("tr", { class: "clicavel arvore-n2" }, el("td"),
            el("td", {}, el("span", { style: { paddingLeft: "14px" } }, s2, " ", budNomeMes(m.mes, true))),
            el("td", { class: "num" }, m.medicoes ? App.fmt.brl(m.medicoes) : "—"), el("td", { class: "num" }, m.pedidos ? App.fmt.brl(m.pedidos) : "—"),
            el("td"), el("td", { class: "num" }, el("b", {}, App.fmt.brl(m.gasto))), el("td", { colspan: 3 }));
          let netos = [];
          tm.onclick = async () => {
            if (netos.length) { netos.forEach((f) => f.remove()); filhos = filhos.filter((f) => !netos.includes(f)); netos = []; s2.textContent = "▸"; return; }
            s2.textContent = "▾";
            const itens = (await App.api(`/api/budget/detalhe?item=${l.item_id}&mes=${m.mes}`))
              .filter((it) => !l.origem || (l.origem === "medicoes" ? it.tipo !== "PEDIDO" : it.tipo === "PEDIDO"));
            let ant = tm;
            netos = itens.map((it) => {
              const link = it.tipo === "PEDIDO" && it.tem_anexo ? el("a", { href: `/api/budget/pedidos/${it.id}/anexo`, target: "_blank" }, " (anexo)") : null;
              const t = el("tr", { class: "arvore-n3" }, el("td"),
                el("td", {}, el("span", { style: { paddingLeft: "34px", display: "inline-flex", gap: "8px", alignItems: "center" } },
                  el("span", { class: "etiqueta " + (it.tipo === "PEDIDO" ? "etiqueta--ok" : "etiqueta--aviso") }, it.tipo === "CONSUMO" ? "CONTA DE CONSUMO" : it.tipo), App.fmt.dataCurta(it.data))),
                el("td", { colspan: 3 }, it.descricao, link),
                el("td", { class: "num" }, el("b", {}, App.fmt.brl(it.valor))), el("td", { colspan: 3 }));
              ant.after(t); ant = t; return t;
            });
            if (!netos.length) { const v = el("tr", { class: "arvore-n3" }, el("td"), el("td", { colspan: cols.length - 1, class: "ajuda" }, "Sem lançamentos.")); tm.after(v); netos = [v]; }
            filhos.push(...netos);
          };
          ultimo.after(tm); ultimo = tm; filhos.push(tm);
        }
      };
      tr.children[0].onclick = abrir; tr.children[1].onclick = abrir;
      tr._fechar = () => { if (filhos.length) abrir(); };
      tbody.append(tr);
    }
    cab.onclick = (ev) => {
      if (ev.target.closest("button, input, a")) return;
      const agoraFechado = !linhasTr[0].hidden;
      linhasTr.forEach((t) => { if (agoraFechado) t._fechar(); t.hidden = agoraFechado; });
      setaG.textContent = agoraFechado ? "▸" : "▾";
      est.fechados = agoraFechado ? [...new Set([...(est.fechados || []), pj])] : (est.fechados || []).filter((x) => x !== pj);
      salvar();
    };
  }
  const T = (f) => App.soma(linhas, (l) => f(l) || 0);
  const baseT = T((l) => l.aprovado), gastoT = T((l) => l.gasto), gastoTA = App.soma(linhas.filter((l) => l.aprovado != null), (l) => l.gasto);
  const tfoot = el("tfoot", {}, el("tr", {}, el("td"), el("td", {}, `Total · ${linhas.length} linha(s)`),
    el("td", { class: "num" }, App.fmt.brl(T((l) => l.solicitado))), el("td", { class: "num" }, App.fmt.brl(T((l) => l.aprovado))),
    el("td", { class: "num" }, corte(linhas.some((l) => l.corte != null) ? T((l) => l.corte) : null)),
    el("td", { class: "num" }, App.fmt.brl(gastoT)), el("td", { class: "num" }, App.fmt.brl(baseT - gastoTA)),
    el("td", { class: "num" }, budPct(baseT ? Math.round(1000 * gastoTA / baseT) / 10 : null)), el("td")));
  const todos = el("div", { class: "linha-acoes", style: { margin: "0 0 8px" } },
    el("button", { class: "btn btn--mini btn--linha", onclick: () => { est.fechados = []; salvar(); App.rotear(); } }, "▾ Abrir todos os projetos"),
    el("button", { class: "btn btn--mini btn--linha", onclick: () => { est.fechados = Object.keys(App.agrupar(linhas, (l) => l.projeto || "")); salvar(); App.rotear(); } }, "▸ Recolher todos"),
    editavel ? el("span", { class: "ajuda", style: { marginLeft: "auto" } }, "Clique em Solicitado ou Aprovado para digitar o valor · Enter grava · Esc desfaz") : null);
  return App.cartao(`Budget ${ano} por projeto`, "clique na classe para ver os meses; no mês, as medições e os pedidos", todos,
    el("div", { class: "tabela-wrap tabela-wrap--alta" }, el("table", { class: "tabela tabela--arvore tabela--budget" },
      el("thead", {}, el("tr", {}, cols.map((c, i) => el("th", { class: NUM.includes(i) ? "num" : "" }, c, BUD_AJ_COL[c] ? App.botaoAjuda(BUD_AJ_COL[c], c) : null)))), tbody, tfoot)));
}

const BUD_AJ_COL = {
  "Classe financeira": "Linha do budget: classe financeira dentro do projeto e centro de custo. Clique para abrir os meses.",
  "Solicitado": "Valor que a gestora pediu para esta linha no ano.",
  "Aprovado": "Valor que a controladoria aprovou para esta linha no ano. É o limite de gasto.",
  "Aprovado − solicitado": "Diferença entre o aprovado e o pedido. Negativo = corte; positivo = aprovado acima do pedido.",
  "Incorrido": "Tudo o que já foi gasto na linha: medições de NF + pedidos de compra + contas de consumo (só a parte da Engenharia).",
  "Saldo do aprovado": "Aprovado − incorrido. Quanto ainda pode ser gasto. Negativo = estourou.",
  "% do aprovado": "Incorrido ÷ aprovado. Acima de 100% = estourou o budget da linha.",
};

/** Gráficos e tabelas de análise: como o gasto aconteceu (quando, onde, com quem e por quê). */
function budGraficos(alvo, linhas, lancs, ano) {
  const meses = Array.from({ length: 12 }, (_, i) => `${ano}-${String(i + 1).padStart(2, "0")}`);
  const porMes = Object.fromEntries(meses.map((m) => [m, { med: 0, ped: 0 }]));
  linhas.forEach((l) => l.meses.forEach((m) => { if (porMes[m.mes]) { porMes[m.mes].med += m.medicoes; porMes[m.mes].ped += m.pedidos; } }));
  let acum = 0;
  const gastoAcum = meses.map((m) => (acum += porMes[m].med + porMes[m].ped));
  const hoje = App.hoje().slice(0, 7);
  // aprovado = só o que a controladoria aprovou (mesmo número do quadro "Aprovado" no topo)
  const sol = App.soma(linhas, (l) => l.solicitado || 0), apr = App.soma(linhas, (l) => l.aprovado || 0);
  const semApr = linhas.filter((l) => l.aprovado == null).length;
  const notaSemApr = semApr ? ` · ${semApr} linha(s) ainda sem aprovado` : "";
  const C = { sol: "#C9B3EE", apr: "#A7D296", gasto: BUD_CORES.med, aprLinha: "#4F8F33", solLinha: "#A876F0" };
  const cartaoGrafico = (titulo, sub, legenda, g) => App.cartao(titulo, sub, legenda, el("div", { style: { height: "8px" } }), g.div);
  const leg3 = () => G.legenda([["Solicitado", C.sol], ["Aprovado", C.apr], ["Incorrido", C.gasto]]);
  const tres = (xs) => [{ rotulo: "Solicitado", cor: C.sol, valores: xs.map((x) => x.sol) }, { rotulo: "Aprovado", cor: C.apr, valores: xs.map((x) => x.apr) }, { rotulo: "Incorrido", cor: C.gasto, valores: xs.map((x) => x.gasto) }];
  const agrupar = (f, rot) => Object.entries(App.agrupar(linhas, f)).map(([k, l]) => ({ k: rot(k) || "(vazio)",
    sol: App.soma(l, (x) => x.solicitado || 0), apr: App.soma(l, (x) => x.aprovado || 0), gasto: App.soma(l, (x) => x.gasto) }))
    .sort((a, b) => Math.max(b.apr, b.sol, b.gasto) - Math.max(a.apr, a.sol, a.gasto)).slice(0, 15);
  const altura = (n, por = 56) => Math.max(220, n * por + 60) + "px";
  /** altura pelos rótulos já quebrados: cada linha de texto ocupa ~19px, mínimo de 38px por barra */
  const alturaRot = (rots) => Math.max(220, App.soma(rots, (r) => Math.max(38, (Array.isArray(r) ? r.length : 1) * 19 + 12)) + 60) + "px";

  alvo.append(el("div", { class: "secao" }, el("h3", {}, "Como o incorrido aconteceu"), el("p", {}, `${App.fmt.num(lancs.length)} lançamento(s) em ${ano} nas linhas filtradas`)));

  /* 1. quando: por mês e acumulado */
  const g1 = G.area("grafico"), g2 = G.area("grafico");
  alvo.append(el("div", { class: "grade g-12" },
    el("div", { class: "s-6" }, cartaoGrafico("Incorrido por mês", "medições de NF + pedidos", G.legenda([["Medições", BUD_CORES.med], ["Pedidos", BUD_CORES.ped]]), g1)),
    el("div", { class: "s-6" }, cartaoGrafico("Incorrido acumulado no ano × aprovado e solicitado", "o incorrido soma mês a mês; as linhas tracejadas são os valores fixos do ano" + notaSemApr,
      G.legenda([["Incorrido acumulado", C.gasto], ["Aprovado no ano", C.aprLinha], ["Solicitado no ano", C.solLinha]], true), g2))));
  G.barrasEmpilhadas(g1.canvas, meses.map((m) => budNomeMes(m)), [
    { rotulo: "Medições", cor: BUD_CORES.med, valores: meses.map((m) => porMes[m].med) },
    { rotulo: "Pedidos", cor: BUD_CORES.ped, valores: meses.map((m) => porMes[m].ped) }], { rotacao: 0 });
  G.linha(g2.canvas, meses.map((m) => budNomeMes(m)), [
    { rotulo: "Incorrido acumulado", cor: C.gasto, valores: meses.map((m, i) => (m <= hoje || String(ano) < hoje.slice(0, 4) ? gastoAcum[i] : null)), area: true },
    { rotulo: "Aprovado no ano", cor: C.aprLinha, valores: meses.map(() => apr), tracejado: true, rotuloFim: "Aprovado" },
    sol ? { rotulo: "Solicitado no ano", cor: C.solLinha, valores: meses.map(() => sol), tracejado: true, rotuloFim: "Solicitado" } : null].filter(Boolean),
    { fmt: App.fmt.brlCurto, eixoY: { suggestedMax: Math.max(apr, sol, acum) * 1.12 } });

  /* 2. onde: por projeto e por centro de custo */
  const pj = agrupar((l) => l.projeto, App.bud.rotPj), cc = agrupar((l) => l.centro_custo, App.bud.rotCc);
  const g3 = G.area("grafico"), g4 = G.area("grafico");
  g3.div.style.height = altura(pj.length, 70); g4.div.style.height = altura(cc.length, 70);
  alvo.append(el("div", { class: "grade g-12", style: { marginTop: "16px" } },
    el("div", { class: "s-6" }, cartaoGrafico("Solicitado × aprovado × incorrido por projeto", "quanto foi pedido, aprovado e incorrido", leg3(), g3)),
    el("div", { class: "s-6" }, cartaoGrafico("Solicitado × aprovado × incorrido por centro de custo", "quanto foi pedido, aprovado e incorrido", leg3(), g4))));
  G.barrasAgrupadas(g3.canvas, pj.map((x) => App.quebrar(x.k, 22)), tres(pj), { horizontal: true });
  G.barrasAgrupadas(g4.canvas, cc.map((x) => App.quebrar(x.k, 22)), tres(cc), { horizontal: true });

  /* 3. em quê: execução de cada classe e gasto por classe (medições × pedidos) */
  const nomeClasse = (l) => `${l.classe_numero} ${(l.classe_descricao || "").replace(/^CUSTOS - /, "")}${new Set(linhas.map((x) => x.projeto)).size > 1 ? ` (${l.projeto || "—"})` : ""}`;
  const exec = linhas.filter((l) => l.aprovado > 0).map((l) => ({ ...l, pctApr: Math.round(1000 * l.gasto / l.aprovado) / 10 }))
    .sort((a, b) => b.pctApr - a.pctApr).slice(0, 15);
  const porClasse = [...linhas].sort((a, b) => b.gasto - a.gasto).filter((l) => l.gasto).slice(0, 15);
  const g5 = G.area("grafico"), g6 = G.area("grafico");
  const rotExec = exec.map((l) => App.quebrar(nomeClasse(l), 27)), rotClasse = porClasse.map((l) => App.quebrar(nomeClasse(l), 27));
  g5.div.style.height = alturaRot(rotExec); g6.div.style.height = alturaRot(rotClasse);
  alvo.append(el("div", { class: "grade g-12", style: { marginTop: "16px" } },
    el("div", { class: "s-6" }, cartaoGrafico("Execução por classe financeira", "quanto do aprovado de cada classe já foi incorrido (as 15 mais executadas); passou da linha de 100% = estourou" + notaSemApr,
      G.legenda([["Até 85%", "#4F8F33"], ["85% a 100%", BUD_CORES.med], ["Acima de 100%", BUD_CORES.alerta]]), g5)),
    el("div", { class: "s-6" }, cartaoGrafico("Incorrido por classe financeira", "as 15 classes que mais gastaram, por origem",
      G.legenda([["Medições", BUD_CORES.med], ["Pedidos", BUD_CORES.ped]]), g6))));
  if (exec.length) G.barrasH(g5.canvas, rotExec, exec.map((l) => l.pctApr),
    exec.map((l) => (l.pctApr > 100 ? BUD_CORES.alerta : l.pctApr > 85 ? BUD_CORES.med : "#4F8F33")),
    { fmt: (v) => App.fmt.pct(v), fmtEixo: (v) => v + "%", linhaRef: { valor: 100, rotulo: "100% do aprovado" },
      tooltipExtra: (i) => `incorrido ${App.fmt.brl(exec[i].gasto)} de ${App.fmt.brl(exec[i].aprovado)} aprovado` });
  else g5.div.append(el("p", { class: "ajuda" }, "Nenhuma linha com aprovado ainda."));
  if (porClasse.length) G.barrasHEmpilhadas(g6.canvas, rotClasse, [
    { rotulo: "Medições", cor: BUD_CORES.med, valores: porClasse.map((l) => l.medicoes) },
    { rotulo: "Pedidos", cor: BUD_CORES.ped, valores: porClasse.map((l) => l.pedidos) }]);
  else g6.div.append(el("p", { class: "ajuda" }, "Nada incorrido nas linhas filtradas."));

  /* 4. com quem e por quê: fornecedores e motivos dos pedidos */
  const somarPor = (xs, f) => Object.entries(App.agrupar(xs, f)).map(([k, l]) => ({ k: k || "(não informado)", v: App.soma(l, (x) => x.valor), n: l.length }))
    .sort((a, b) => b.v - a.v);
  const forn = somarPor(lancs, (x) => x.fornecedor).slice(0, 12);
  const motivos = somarPor(lancs.filter((x) => x.tipo === "PEDIDO"), (x) => x.motivo);
  const g7 = G.area("grafico"), g8 = G.area("grafico");
  const rotForn = forn.map((x) => App.quebrar(x.k, 25)), rotMot = motivos.map((x) => App.quebrar(x.k, 25));
  g7.div.style.height = alturaRot(rotForn); g8.div.style.height = alturaRot(rotMot);
  alvo.append(el("div", { class: "grade g-12", style: { marginTop: "16px" } },
    el("div", { class: "s-6" }, cartaoGrafico("Maiores fornecedores", "valor medido + pedidos no ano (os 12 maiores)", null, g7)),
    el("div", { class: "s-6" }, cartaoGrafico("Pedidos por motivo", "valor dos pedidos de compra no ano", null, g8))));
  const tip = (xs) => (i) => `${xs[i].n} lançamento(s)`;
  if (forn.length) G.barrasH(g7.canvas, rotForn, forn.map((x) => x.v), forn.map(() => BUD_CORES.med), { tooltipExtra: tip(forn) });
  else g7.div.append(el("p", { class: "ajuda" }, "Sem lançamentos."));
  if (motivos.length) G.barrasH(g8.canvas, rotMot, motivos.map((x) => x.v), motivos.map(() => BUD_CORES.ped), { tooltipExtra: tip(motivos) });
  else g8.div.append(el("p", { class: "ajuda" }, "Nenhum pedido de compra nas linhas filtradas."));

  /* 5. mapa mensal: classe × mês */
  alvo.append(el("div", { style: { marginTop: "16px" } }, budMapaMensal(linhas, meses, nomeClasse)));

  /* 6. maiores lançamentos, agrupados por fornecedor (clique no fornecedor para ver os lançamentos dele) */
  alvo.append(el("div", { style: { marginTop: "16px" } }, budMaioresPorFornecedor(lancs, linhas)));
}

function budMaioresPorFornecedor(lancs, linhas) {
  const linhaDe = Object.fromEntries(linhas.map((l) => [l.item_id, l]));
  const total = App.soma(lancs, (x) => x.valor);
  const grupos = Object.entries(App.agrupar(lancs, (x) => x.fornecedor || "(fornecedor não informado)"))
    .map(([f, ls]) => ({ f, ls: ls.sort((a, b) => b.valor - a.valor), v: App.soma(ls, (x) => x.valor) })).sort((a, b) => b.v - a.v);
  if (!grupos.length) return App.cartao("Maiores lançamentos por fornecedor", "", el("p", { class: "ajuda" }, "Sem lançamentos."));
  const tbody = el("tbody");
  let todos = false;
  const desenhar = () => {
    App.limpar(tbody);
    (todos ? grupos : grupos.slice(0, 15)).forEach((g) => {
      const nMed = g.ls.filter((x) => x.tipo !== "PEDIDO").length, nPed = g.ls.length - nMed;
      const classes = [...new Set(g.ls.map((x) => (linhaDe[x.item_id] || {}).classe_numero).filter(Boolean))];
      const seta = el("span", { class: "arvore-seta" }, "▸");
      const tr = el("tr", { class: "clicavel grupo-fornecedor", title: "Clique para ver os lançamentos deste fornecedor" },
        el("td", {}, seta, " ", el("b", {}, g.f)),
        el("td", {}, [nMed ? `${nMed} medição(ões)` : "", nPed ? `${nPed} pedido(s)` : ""].filter(Boolean).join(" · ")),
        el("td", {}, classes.join(", ") || "—"),
        el("td", {}, App.fmt.dataCurta(g.ls.map((x) => x.data).sort().pop())),
        el("td", { class: "num" }, budPct(total ? Math.round(1000 * g.v / total) / 10 : null)),
        el("td", { class: "num" }, el("b", {}, App.fmt.brl(g.v))));
      let filhos = [];
      tr.onclick = () => {
        if (filhos.length) { filhos.forEach((f) => f.remove()); filhos = []; seta.textContent = "▸"; return; }
        seta.textContent = "▾";
        let ant = tr;
        filhos = g.ls.map((x) => {
          const l = linhaDe[x.item_id] || {};
          const t = el("tr", { class: "arvore-n3" },
            el("td", { style: { paddingLeft: "30px" } }, el("span", { class: "etiqueta " + (x.tipo === "PEDIDO" ? "etiqueta--ok" : "etiqueta--aviso") }, x.tipo === "MEDIÇÃO" ? "Medição" : x.tipo === "CONSUMO" ? "Conta de consumo" : "Pedido"),
              " ", App.fmt.dataCurta(x.data)),
            el("td", {}, x.ref + (x.motivo ? ` · ${x.motivo}` : "")),
            el("td", {}, `${l.classe_numero || ""} ${l.classe_descricao || ""}`.trim() || "—"),
            el("td", {}, l.projeto ? `projeto ${l.projeto}` : "—"), el("td"),
            el("td", { class: "num" }, App.fmt.brl(x.valor)));
          ant.after(t); ant = t; return t;
        });
      };
      tbody.append(tr);
    });
  };
  desenhar();
  const btnTodos = grupos.length > 15 ? el("button", { class: "btn btn--mini btn--linha" }, `Mostrar todos os ${grupos.length} fornecedores`) : null;
  if (btnTodos) btnTodos.onclick = () => { todos = !todos; btnTodos.textContent = todos ? "Mostrar só os 15 maiores" : `Mostrar todos os ${grupos.length} fornecedores`; desenhar(); };
  return App.cartao("Maiores lançamentos por fornecedor", `${grupos.length} fornecedor(es) · clique no fornecedor para ver cada medição e pedido`,
    el("div", { class: "tabela-wrap" }, el("table", { class: "tabela tabela--arvore" },
      el("thead", {}, el("tr", {}, ["Fornecedor", "Lançamentos", "Classes financeiras", "Último lançamento", "% do incorrido", "Incorrido"].map((c, i) => el("th", { class: i >= 4 ? "num" : "" }, c)))),
      tbody,
      el("tfoot", {}, el("tr", {}, el("td", {}, "Total"), el("td", {}, `${lancs.length} lançamento(s)`), el("td"), el("td"), el("td"), el("td", { class: "num" }, App.fmt.brl(total)))))),
    btnTodos ? el("div", { class: "linha-acoes" }, btnTodos) : null);
}

/** Tabela classe × mês, com a cor da célula mais forte quanto maior o gasto. */
function budMapaMensal(linhas, meses, nomeClasse) {
  const ls = [...linhas].filter((l) => l.gasto).sort((a, b) => b.gasto - a.gasto);
  if (!ls.length) return App.cartao("Incorrido mensal por classe financeira", "", el("p", { class: "ajuda" }, "Nada incorrido nas linhas filtradas."));
  const val = (l, m) => (l.meses.find((x) => x.mes === m) || {}).gasto || 0;
  const max = Math.max(...ls.flatMap((l) => meses.map((m) => val(l, m))), 1);
  const cel = (v) => {
    if (!v) return el("td", { class: "num mapa-vazio" }, "—");
    const a = 0.08 + 0.82 * (v / max);
    return el("td", { class: "num", title: App.fmt.brl(v), style: { background: `rgba(106,11,176,${a.toFixed(2)})`, color: a > 0.5 ? "#fff" : "var(--p900)" } }, curto(v));
  };
  // número curto para caber os 12 meses: acima de 100 mil sem casa decimal (o valor exato aparece ao passar o mouse)
  const curto = (v) => Math.abs(v) >= 1e5 && Math.abs(v) < 1e6 ? `${Math.round(v / 1e3).toLocaleString("pt-BR")} mil` : App.fmt.brlCurto(v).replace(/^R\$\s*/, "");
  const totMes = meses.map((m) => App.soma(ls, (l) => val(l, m)));
  return App.cartao("Incorrido mensal por classe financeira", "valores em R$ · cor mais forte = mês com mais incorrido · passe o mouse para ver o valor exato",
    el("div", { class: "tabela-wrap tabela-wrap--alta" }, el("table", { class: "tabela tabela--mapa" },
      el("thead", {}, el("tr", {}, el("th", {}, "Classe financeira"), meses.map((m) => el("th", { class: "num" }, budNomeMes(m))), el("th", { class: "num" }, "Total"), el("th", { class: "num" }, "% do aprovado"))),
      el("tbody", {}, ls.map((l) => el("tr", {}, el("td", { class: "mapa-classe" }, nomeClasse(l)), meses.map((m) => cel(val(l, m))),
        el("td", { class: "num" }, el("b", {}, App.fmt.brlCurto(l.gasto))),
        el("td", { class: "num", style: { color: l.pct > 100 ? "var(--perigo)" : "" } }, App.fmt.pct(l.pct))))),
      el("tfoot", {}, el("tr", {}, el("td", {}, "Total"), totMes.map((v) => el("td", { class: "num" }, v ? curto(v) : "—")),
        el("td", { class: "num" }, App.fmt.brlCurto(App.soma(ls, (l) => l.gasto))), el("td"))))));
}

/** Solicitado → aprovado → gasto → saldo de uma linha. */
function budResumoLinha(l) {
  const item = (rot, v, cor, sub) => el("div", { class: "resumo-linha__item" }, el("span", {}, rot), el("b", { style: { color: cor || "" } }, v), sub ? el("small", {}, sub) : null);
  return el("div", { class: "resumo-linha" },
    item("Solicitado", l.solicitado == null ? "—" : App.fmt.brl(l.solicitado), null, "pedido pela gestora"),
    item("Aprovado", l.aprovado == null ? "—" : App.fmt.brl(l.aprovado), null, l.corte == null ? "pela controladoria" : `${l.corte < 0 ? "corte de " : "+ "}${App.fmt.brl(Math.abs(l.corte))}`),
    item("Incorrido", App.fmt.brl(l.gasto), null, `medições ${App.fmt.brlCurto(l.medicoes)}${l.consumo ? ` (contas de consumo ${App.fmt.brlCurto(l.consumo)})` : ""} · pedidos ${App.fmt.brlCurto(l.pedidos)}`),
    item("Saldo do aprovado", l.saldo == null ? "—" : App.fmt.brl(l.saldo), l.saldo < 0 ? "var(--perigo)" : "#23511A", l.saldo == null ? "ainda sem aprovado" : `${App.fmt.pct(l.pct)} executado`));
}

async function budTirarLinha(l, ano) {
  if (!(await App.confirmar("Tirar do budget", `Tirar a linha ${l.classe_numero} ${l.classe_descricao || ""} · projeto ${App.bud.rotPj(l.projeto) || "—"} · CC ${App.bud.rotCc(l.centro_custo) || "—"} do budget de ${ano}? `
    + "As medições e os pedidos continuam cadastrados (passam a aparecer como “fora do budget”).", "Tirar"))) return;
  try { await App.api(`/api/budget/linhas/${ano}/${l.item_id}`, { method: "DELETE" }); App.toast("Linha tirada do budget."); App.rotear(); } catch (e) { App.toast(e.message, true); }
}

async function budExcluirAno(ano) {
  if (!(await App.confirmar(`Excluir o budget de ${ano}`, `Apagar TODOS os valores (solicitado e aprovado) de ${ano}? As medições, os pedidos e os cadastros continuam no site; `
    + `só o budget de ${ano} é apagado (dá para lançar de novo depois).`, `Excluir ${ano}`))) return;
  try {
    const r = await App.api(`/api/budget/anos/${ano}`, { method: "DELETE" });
    sessionStorage.removeItem("bud_ano"); App.toast(`Budget de ${ano} excluído (${r.n} linha(s)).`); App.rotear();
  } catch (e) { App.toast(e.message, true); }
}

function budNovoAno(anos) {
  const ano = el("input", { type: "number", value: (Math.max(...anos, new Date().getFullYear() - 1) + 1), min: "2000", max: "2100" });
  const copiar = el("select", {}, el("option", { value: "" }, "Não copiar (começar vazio)"), anos.map((a) => el("option", { value: a }, `Copiar as linhas de ${a}`)));
  const valores = el("input", { type: "checkbox" });
  const msg = el("p", { class: "ajuda", style: { color: "var(--perigo)", minHeight: "18px" } });
  App.modal(el("div", {}, el("h3", {}, "Novo ano do budget"),
    el("div", { class: "grade", style: { gap: "10px" } },
      el("label", { class: "campo" }, el("span", {}, "Ano"), ano),
      el("label", { class: "campo" }, el("span", {}, "Linhas"), copiar),
      el("label", { style: { display: "flex", gap: "8px", alignItems: "center" } }, valores, "Copiar também os valores (solicitado e aprovado)")),
    msg,
    el("div", { class: "linha-acoes" }, el("button", { class: "btn", onclick: async () => {
      try {
        await App.api("/api/budget/anos", { method: "POST", json: { ano: ano.value, copiar_de: copiar.value || null, copiar_valores: valores.checked } });
        sessionStorage.setItem("bud_ano", ano.value); App.fecharModal(); App.rotear();
      } catch (e) { msg.textContent = e.message; }
    } }, "Criar"), el("button", { class: "btn btn--linha", "data-fechar": "" }, "Cancelar"))));
}

function budEditarLinha(l) {
  const novo = !l.item_id;
  const cps = App.bud.camposClasse(l, { semAviso: true, vazio: "Escolha…" });
  const desc = el("div", { class: "ajuda" });
  const mostrarDesc = () => {
    const c = App.bud.base.cadastros.classes.find((x) => x.numero === cps.cl.value);
    desc.textContent = c ? `Descrição da classe: ${c.descricao || "(sem descrição — edite em Cadastros)"}` : "";
  };
  cps.cl.addEventListener("change", mostrarDesc); mostrarDesc();
  const sol = el("input", { type: "number", step: "0.01", min: "0", value: l.solicitado ?? "" });
  const apr = el("input", { type: "number", step: "0.01", min: "0", value: l.aprovado ?? "" });
  const msg = el("p", { class: "ajuda", style: { color: "var(--perigo)", minHeight: "18px" } });
  const progressoLinha = App.progressoForm([{ rotulo: "classe financeira", ok: () => !!cps.cl.value }, { rotulo: "centro de custo ou projeto", ok: () => !!(cps.cc.value || cps.pj.value) }]);
  App.modal(el("div", { class: "modal--largo" }, el("h3", {}, novo ? `Nova linha do budget ${l.ano}` : `Linha do budget ${l.ano}`), progressoLinha,
    novo ? null : budResumoLinha(l),
    el("div", { class: "grade-form" }, cps.campos(),
      el("div", { class: "campo campo--largo" }, desc),
      el("label", { class: "campo" }, el("span", {}, `Solicitado ${l.ano} (gestora)`), sol),
      el("label", { class: "campo" }, el("span", {}, `Aprovado ${l.ano} (controladoria)`), apr)),
    el("p", { class: "ajuda" }, "A mesma classe pode aparecer em outros projetos ou centros de custo, cada um com seus valores. Campo vazio = sem valor. ", App.bud.linkCadastros()),
    msg,
    el("div", { class: "linha-acoes" },
      el("button", { class: "btn", onclick: async () => {
        if (!cps.cl.value) { msg.textContent = "Escolha a classe financeira."; return; }
        try {
          await App.api("/api/budget/linhas", { method: "POST", json: { ano: l.ano, item_id: l.item_id, ...cps.valores(),
            classe_descricao: (App.bud.base.cadastros.classes.find((x) => x.numero === cps.cl.value) || {}).descricao || "",
            solicitado: sol.value === "" ? (l.solicitado != null ? "-" : "") : sol.value,
            aprovado: apr.value === "" ? (l.aprovado != null ? "-" : "") : apr.value } });
          App.fecharModal(); App.toast("Linha salva."); App.rotear();
        } catch (e) { msg.textContent = e.message; }
      } }, "Salvar"),
      el("button", { class: "btn btn--linha", "data-fechar": "" }, "Cancelar"),
      novo ? null : el("button", { class: "btn btn--perigo", style: { marginLeft: "auto" }, onclick: async () => {
        if (!(await App.confirmar("Tirar do budget", `Tirar a classe ${l.classe_numero} (${l.projeto}) do budget de ${l.ano}? Os pedidos e medições continuam cadastrados, mas passam a aparecer como “fora do budget”.`, "Tirar"))) return;
        await App.api(`/api/budget/linhas/${l.ano}/${l.item_id}`, { method: "DELETE" }); App.rotear();
      } }, "Tirar do budget"))));
}

/** Faixa: lançamentos com centro de custo/projeto/classe que não estão no budget (valor não calculado). */
function budFaixaFora(f, ano) {
  const sc = f.sem_classe;
  if (!f.n && !sc.medicoes.n && !sc.pedidos.n) return null;
  return el("div", { class: "alertas-nf" },
    f.n ? el("a", { class: "alerta-nf alerta-nf--saldo", onclick: () => budListaFora(f, ano) }, el("i", { class: "alerta-ponto" }),
      el("span", {}, el("b", {}, `${App.fmt.brl(f.valor)} em ${f.n} lançamento(s)`),
        ` com centro de custo / projeto / classe que não está no budget de ${ano} — o valor não está sendo calculado. Ver lista →`)) : null,
    sc.medicoes.n || sc.pedidos.n ? el("span", { class: "alerta-nf alerta-nf--venc", title: "Escolha a classe no contrato (ou no item do contrato) e nos pedidos" }, el("i", { class: "alerta-ponto alerta-ponto--info" }),
      el("span", {}, [sc.medicoes.n ? `${sc.medicoes.n} medição(ões) (${App.fmt.brlCurto(sc.medicoes.valor)})` : "", sc.pedidos.n ? `${sc.pedidos.n} pedido(s) (${App.fmt.brlCurto(sc.pedidos.valor)})` : ""].filter(Boolean).join(" e "),
        ` de ${ano} sem classe financeira (não entram no budget).`)) : null);
}

function budListaFora(f, ano) {
  App.modal(el("div", { class: "modal--largo" }, el("h3", {}, `Fora do budget de ${ano}`),
    el("p", { class: "ajuda", style: { marginTop: 0 } }, "Estes lançamentos têm classe financeira, mas a combinação centro de custo + projeto + classe não tem linha no budget do ano — por isso o valor não entra na conta. Para corrigir: crie a linha no budget (+ Linha do budget) ou troque a classe no pedido / contrato / medição."),
    App.tabela([
      { rotulo: "Tipo", valor: (x) => x.tipo, render: (x) => el("span", { class: "etiqueta " + (x.tipo === "PEDIDO" ? "etiqueta--ok" : "etiqueta--aviso") }, x.tipo) },
      { rotulo: "Data", valor: (x) => x.data, render: (x) => App.fmt.dataCurta(x.data) },
      { rotulo: "Lançamento", valor: (x) => x.descricao },
      { rotulo: "Centro de custo · projeto · classe", valor: (x) => `${x.centro_custo} ${x.projeto} ${x.classe_numero}`,
        render: (x) => el("div", { class: "celula-2l" }, el("span", {}, `${x.classe_numero} ${x.classe_descricao || ""}`), el("small", {}, `${App.bud.rotCc(x.centro_custo) || "sem centro de custo"} · ${App.bud.rotPj(x.projeto) || "sem projeto"}`)) },
      { rotulo: "Valor", num: true, valor: (x) => x.valor, render: (x) => App.fmt.brl(x.valor), total: (l) => App.fmt.brl(App.soma(l, (x) => x.valor)) },
    ], f.itens, { rodape: true, ordem: { i: 1, dir: -1 }, onClick: (x) => { App.fecharModal(); location.hash = x.tipo === "PEDIDO" ? "#/nf/pedidos" : "#/nf/medicoes"; } }),
    el("div", { class: "linha-acoes" },
      App.btnEditor(`+ Pôr estas ${new Set(f.itens.map((x) => x.item_id)).size} linha(s) no budget de ${ano} (sem valores)`, async () => {
        const ids = [...new Set(f.itens.filter((x) => String(x.data).startsWith(String(ano))).map((x) => x.item_id))];
        try {
          const r = await App.api("/api/budget/linhas/lote", { method: "POST", json: { ano, item_ids: ids } });
          App.fecharModal(); App.toast(`${r.n} linha(s) incluída(s) no budget de ${ano}. Digite o solicitado e o aprovado de cada uma na tabela.`); App.rotear();
        } catch (e) { App.toast(e.message, true); }
      }, "btn"),
      el("button", { class: "btn btn--linha", "data-fechar": "" }, "Fechar"))));
}

/* ------------------------------------------------------------------ PEDIDOS */
async function budPedidos(raiz) {
  const B = App.bud.base;
  const est = { motivo: "", status: "", q: "" };
  try { Object.assign(est, JSON.parse(sessionStorage.getItem("bud_ped_filtro") || "{}")); } catch (e) { /* ok */ }
  delete est.ano;   // o ano virou o período do filtro comum
  const salvar = () => { try { sessionStorage.setItem("bud_ped_filtro", JSON.stringify(est)); } catch (e) { /* ok */ } };
  raiz.append(el("div", { class: "pagina-cabecalho" },
    el("div", {}, el("h2", {}, "Pedidos de compra"), el("p", {}, "Pedidos de compra e serviço, ligados às classes financeiras do budget")),
    el("div", { class: "acoes" }, budBotoesExcel("pedidos"), budBotaoPdf(), App.btnEditor("+ Novo pedido", () => budEditarPedido({}), "btn"))));
  // período, centro de custo e projeto: filtro comum das guias de Notas fiscais
  App.exportarExcel = { rotulo: "Pedidos de compra (com os filtros da tela)", url: () => "/api/budget/exportar?" + new URLSearchParams({ tipo: "pedidos", ...App.nf.fcParams() }) };
  const selMot = el("select", {}, el("option", { value: "" }, "Todos"), B.motivos.map((m) => el("option", { value: m, selected: m === est.motivo }, m.charAt(0) + m.slice(1).toLowerCase())));
  const selSt = el("select", {}, [["", "Todos"], ["ATIVO", "Ativos"], ["CANCELADO", "Cancelados"]].map(([v, r]) => el("option", { value: v, selected: v === est.status }, r)));
  const busca = el("input", { type: "search", placeholder: "Nº, fornecedor, projeto, classe…", value: est.q });
  const mudar = () => { Object.assign(est, { motivo: selMot.value, status: selSt.value, q: busca.value }); salvar(); carregar(); };
  [selMot, selSt].forEach((x) => (x.onchange = mudar));
  let tb; busca.oninput = () => { clearTimeout(tb); tb = setTimeout(mudar, 250); };
  raiz.append(App.barraPadrao({ campos: [...App.nf.camposFiltro(() => carregar(), { rotuloData: "Data de emissão" }), App.campo("Motivo", selMot), App.campo("Status", selSt)], busca,
    limpar: () => { App.nf.limparFc(); Object.assign(est, { motivo: "", status: "", q: "" }); salvar(); App.rotear(); } }));
  const alvo = el("div");
  raiz.append(alvo);

  async function carregar() {
    const d = await App.api("/api/budget/pedidos?" + new URLSearchParams({ ...App.nf.fcParams(), ...Object.fromEntries(Object.entries(est).filter(([, v]) => v)) }));
    App.destruirGraficos();
    App.limpar(alvo);
    const t = d.total;
    alvo.append(el("div", { class: "kpis" },
      App.kpi("Pedidos", App.fmt.num(t.n - (t.cancelados || 0)), "core", `${t.cancelados || 0} cancelado(s)`),
      App.kpi("Valor total", App.fmt.brlCurto(t.valor), "p900", "sem os cancelados"),
      App.kpi("Ticket médio", App.fmt.brlCurto((t.n - (t.cancelados || 0)) ? t.valor / (t.n - (t.cancelados || 0)) : 0), "p100", "por pedido"),
      App.kpi("Não calculados no budget", App.fmt.num((t.sem_classe || 0) + (t.fora || 0)), (t.sem_classe || t.fora) ? "p100" : "branco",
        (t.sem_classe || t.fora) ? `${t.sem_classe || 0} sem classe · ${t.fora || 0} fora do budget (${App.fmt.brlCurto(t.valor_fora)})` : "todos entram no budget")));
    if (d.pedidos.length) {
      const g1 = G.area("grafico"), g2 = G.area("grafico"), g3 = G.area("grafico");
      g1.div.style.height = Math.max(220, d.por_motivo.length * 40 + 60) + "px";
      g3.div.style.height = Math.max(220, d.por_projeto.length * 38 + 60) + "px";
      alvo.append(el("div", { class: "grade g-12" },
        el("div", { class: "s-5" }, App.cartao("Valor por motivo", "soma dos pedidos ativos", g1.div)),
        el("div", { class: "s-7" }, App.cartao("Pedidos por mês", "valor emitido em cada mês", g2.div))),
        el("div", { class: "grade", style: { marginTop: "16px" } }, App.cartao("Valor por projeto", "top 15 projetos (pedidos ativos)", g3.div)));
      G.barrasH(g1.canvas, d.por_motivo.map((x) => x.motivo || "Sem motivo"), d.por_motivo.map((x) => x.valor), App.cores.core,
        { tooltipExtra: (i) => ` ${d.por_motivo[i].n} pedido(s)` });
      G.barrasEmpilhadas(g2.canvas, d.por_mes.map((x) => budNomeMes(x.mes)), [{ rotulo: "Valor", cor: BUD_CORES.ped, valores: d.por_mes.map((x) => x.valor) }], { rotacao: d.por_mes.length > 12 ? 45 : 0 });
      G.barrasH(g3.canvas, d.por_projeto.map((x) => App.quebrar(x.projeto || "(sem projeto)", 27)), d.por_projeto.map((x) => x.valor), BUD_CORES.med);
    }
    alvo.append(el("div", { class: "secao" }, el("h3", {}, "Lista")), App.cartao("Pedidos", `${d.pedidos.length} pedido(s) · clique para editar`,
      App.tabela([
        { rotulo: "Nº pedido", valor: (p) => p.numero, render: (p) => el("b", { style: { textDecoration: p.status === "CANCELADO" ? "line-through" : "" } }, p.numero) },
        { rotulo: "Emissão", valor: (p) => p.data_emissao, render: (p) => App.fmt.dataCurta(p.data_emissao) || "—" },
        { rotulo: "Motivo", valor: (p) => p.motivo, render: (p) => p.motivo ? el("span", { class: "etiqueta" }, p.motivo) : "—" },
        { rotulo: "Classe financeira", valor: (p) => p.classe_numero || "", render: (p) => p.rateio ? nfCelulaRateio(p.rateio, false) : p.item_id ? el("div", { class: "celula-2l" }, el("span", {}, `${p.classe_numero} ${p.classe_descricao || ""}`), el("small", {}, [App.bud.rotPj(p.projeto), App.bud.rotCc(p.centro_custo)].filter(Boolean).join(" · ")),
          p.fora_budget ? el("span", { class: "etiqueta etiqueta--alerta", title: `Essa combinação não está no budget de ${(p.data_emissao || "").slice(0, 4)}: o valor não está sendo calculado` }, "Fora do budget") : null) : el("div", { class: "celula-2l" }, el("span", { class: "etiqueta etiqueta--alerta", style: { alignSelf: "flex-start" } }, "Sem classe"),
          p.projeto_pend ? el("small", {}, `projeto ${App.bud.rotPj(p.projeto_pend)}`) : null) },
        { rotulo: "Fornecedor", valor: (p) => p.fornecedor, render: (p) => p.fornecedor || "—" },
        { rotulo: "Valor", num: true, valor: (p) => p.valor, render: (p) => App.fmt.brl(p.valor), total: (l) => App.fmt.brl(App.soma(l.filter((p) => p.status !== "CANCELADO"), (p) => p.valor)) },
        { rotulo: "NFs", num: true, valor: (p) => p.medido, render: (p) => p.n_nfs ? el("div", { class: "celula-2l", style: { textAlign: "right" } },
          el("span", {}, App.fmt.brl(p.medido)), el("small", {}, `${p.n_nfs} NF(s) · saldo ${App.fmt.brl((p.valor || 0) - p.medido)}`)) : "—" },
        { rotulo: "Anexo", render: (p) => p.tem_anexo ? el("a", { href: `/api/budget/pedidos/${p.id}/anexo`, target: "_blank" }, "Abrir anexo") : "—" },
        { rotulo: "Status", valor: (p) => p.status, render: (p) => el("span", { class: "etiqueta " + (p.status === "CANCELADO" ? "etiqueta--alerta" : "etiqueta--ok") }, p.status === "CANCELADO" ? "Cancelado" : "Ativo") },
      ], d.pedidos, { onClick: App.meta.editavel ? budEditarPedido : null, rodape: true, ordem: { i: 1, dir: -1 }, vazio: "Nenhum pedido para os filtros.",
        selecao: App.meta.editavel ? { id: (p) => p.id, nome: "pedido(s)", acoes: (ids) => [el("button", { class: "btn btn--mini btn--perigo", onclick: async () => {
          const lista = ids();
          if (!(await App.confirmar("Excluir pedidos", `Excluir ${lista.length} pedido(s)? Os anexos também são apagados e as NFs ligadas a eles ficam sem pedido.`, "Excluir"))) return;
          try { const r = await App.api("/api/budget/pedidos/excluir", { method: "POST", json: { ids: lista } }); App.toast(`${r.n} pedido(s) excluído(s).`); App.rotear(); }
          catch (e) { App.toast(e.message, true); }
        } }, "Excluir selecionados")] } : null })));
  }
  await carregar();
  App.soltarNaPagina(null, () => App.rotear(), {
    enviar: (files) => {
      const pdfs = [...files].filter((f) => /\.pdf$/i.test(f.name));
      return pdfs.length ? budLerPdfs(pdfs) : App.importacao.importar(files);
    },
    texto: "PDF(s) do pedido de compra (lê nº, fornecedor, valor, projeto…) ou a planilha de importação",
  });
}

async function budEditarPedido(p) {
  const B = App.bud.base;
  const novo = !p.id;
  const num = el("input", { type: "text", value: p.numero || "" });
  const data = el("input", { type: "date", value: p.data_emissao || App.hoje() });
  const valor = el("input", { type: "number", step: "0.01", min: "0", value: p.valor ?? "" });
  const motivo = el("select", {}, el("option", { value: "" }, "Escolha…"), B.motivos.map((m) => el("option", { value: m, selected: m === p.motivo }, m.charAt(0) + m.slice(1).toLowerCase())));
  const cps = App.bud.camposClasse({ centro_custo: p.centro_custo || p.cc_pend || "", projeto: p.projeto || p.projeto_pend || "", classe_numero: p.classe_numero || "" },
    { ano: () => (data.value || "").slice(0, 4), vazio: "—" });
  data.addEventListener("input", cps.checar);
  const forn = el("input", { type: "text", value: p.fornecedor || "", list: "bud-fornecedores" });
  const listaForn = el("datalist", { id: "bud-fornecedores" });
  App.api("/api/nf/pedidos").then((ls) => listaForn.append(...[...new Set(ls.map((x) => x.fornecedor).filter(Boolean))].sort().map((f) => el("option", { value: f })))).catch(() => {});
  const cnpj = el("input", { type: "text", value: p.cnpj || "", placeholder: "00.000.000/0000-00" });
  const processo = el("input", { type: "text", value: p.processo || "" });
  const descricao = el("textarea", { rows: 2 }, p.descricao || "");
  const obs = el("textarea", { rows: 2 }, p.observacao || "");
  const status = el("select", {}, el("option", { value: "ATIVO", selected: p.status !== "CANCELADO" }, "Ativo"), el("option", { value: "CANCELADO", selected: p.status === "CANCELADO" }, "Cancelado"));
  const arq = el("input", { type: "file" });
  const msg = el("p", { class: "ajuda", style: { color: "var(--perigo)", minHeight: "18px" } });
  let ratIni = [];
  if (p.id) { try { ratIni = await App.api(`/api/budget/rateio?tipo=pedido&id=${p.id}`); } catch (e) { /* ok */ } }
  const rat = App.bud.rateio(ratIni, { total: () => +valor.value || 0, ano: () => (data.value || "").slice(0, 4),
    titulo: "Ratear este pedido entre centros de custo / classes financeiras", base: "valor total do pedido" });
  valor.addEventListener("input", rat.atualizar);
  const classeUnica = el("div", { class: "campo--largo" }, el("div", { class: "grade-form" }, cps.campos()), cps.aviso, App.bud.linkCadastros());
  const mostrar = () => { classeUnica.hidden = rat.ativo(); };
  rat.bloco.querySelector("input[type=checkbox]").addEventListener("change", mostrar);
  mostrar();
  App.modal(el("div", { class: "modal--largo" }, el("h3", {}, novo ? "Novo pedido" : `Pedido ${p.numero}`),
    App.progressoForm([{ rotulo: "nº do pedido", ok: () => !!num.value.trim() }, { rotulo: "data", ok: () => !!data.value }, { rotulo: "valor", ok: () => !!valor.value },
      { rotulo: "fornecedor", ok: () => !!forn.value.trim() }]),
    el("div", { class: "grade-form" },
      el("label", { class: "campo" }, el("span", {}, "Nº do pedido"), num),
      el("label", { class: "campo" }, el("span", {}, "Data de emissão"), data),
      el("label", { class: "campo" }, el("span", {}, "Valor total (R$)"), valor),
      el("label", { class: "campo" }, el("span", {}, "Motivo"), motivo),
      el("label", { class: "campo", style: { gridColumn: "span 2" } }, el("span", {}, "Fornecedor"), forn, listaForn),
      el("label", { class: "campo" }, el("span", {}, "CNPJ do fornecedor"), cnpj),
      el("label", { class: "campo" }, el("span", {}, "Processo nº"), processo),
      el("div", {}),
      classeUnica,
      el("div", { class: "campo--largo" }, rat.bloco),
      el("label", { class: "campo campo--largo" }, el("span", {}, "Anexo"), arq, p.tem_anexo ? el("div", { class: "ajuda" }, "Atual: ", el("a", { href: `/api/budget/pedidos/${p.id}/anexo`, target: "_blank" }, "" + (p.anexo_nome || "abrir")), " (escolha outro para trocar)") : null),
      el("label", { class: "campo campo--largo" }, el("span", {}, "Descrição (itens do pedido)"), descricao),
      el("label", { class: "campo campo--largo" }, el("span", {}, "Observação"), obs),
      el("label", { class: "campo" }, el("span", {}, "Status"), status),
      p.n_nfs ? el("div", { class: "campo", style: { gridColumn: "span 2" } }, el("span", {}, "NFs lançadas deste pedido"),
        el("div", {}, `${p.n_nfs} NF(s) · ${App.fmt.brl(p.medido)} · saldo do pedido ${App.fmt.brl((p.valor || 0) - (p.medido || 0))}`)) : null),
    msg,
    el("div", { class: "linha-acoes" },
      el("button", { class: "btn", onclick: async () => {
        const erroRat = rat.validar();
        if (erroRat) { msg.textContent = erroRat; return; }
        const fd = new FormData();
        Object.entries({ id: p.id || "", numero: num.value, data_emissao: data.value, valor: valor.value, motivo: motivo.value, ...cps.valores(), cnpj: cnpj.value, processo: processo.value, descricao: descricao.value,
          fornecedor: forn.value, observacao: obs.value, status: status.value }).forEach(([k, v]) => fd.append(k, v));
        if (arq.files[0]) fd.append("arquivo", arq.files[0]);
        try {
          const r = await fetch("/api/budget/pedidos", { method: "POST", body: fd });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.erro || `Erro ${r.status}`);
          const pid = j.id || p.id;
          if (pid && (rat.ativo() || ratIni.length)) {
            try { await App.bud.salvarRateio("pedido", pid, rat); } catch (e) { msg.textContent = "Pedido salvo, mas o rateio não: " + e.message; return; }
          }
          App.fecharModal(); App.toast(rat.ativo() ? "Pedido salvo com rateio." : "Pedido salvo."); App.rotear();
        } catch (e) { msg.textContent = e.message; }
      } }, "Salvar"),
      el("button", { class: "btn btn--linha", "data-fechar": "" }, "Cancelar"),
      novo ? null : el("button", { class: "btn btn--perigo", style: { marginLeft: "auto" }, onclick: async () => {
        if (!(await App.confirmar("Excluir pedido", `Excluir o pedido ${p.numero}? Se só foi cancelado, prefira mudar o status.`, "Excluir"))) return;
        await App.api(`/api/budget/pedidos/${p.id}`, { method: "DELETE" }); App.rotear();
      } }, "Excluir"))));
}

/* ------------------------------------------------------------------ CADASTROS (listas suspensas) */
const BUD_CAD = {
  centros: { titulo: "Centros de custo", um: "centro de custo", novo: "Novo centro de custo", chave: "nome" },
  projetos: { titulo: "Projetos", um: "projeto", novo: "Novo projeto", chave: "nome" },
  classes: { titulo: "Classes financeiras", um: "classe financeira", novo: "Nova classe financeira", chave: "numero" },
};

async function budCadastros(raiz) {
  const C = App.bud.base.cadastros;
  raiz.append(el("div", { class: "pagina-cabecalho" },
    el("div", {}, el("h2", {}, "Cadastros"), el("p", {}, "Listas suspensas de centro de custo, projeto e classe financeira — usadas no budget, nos pedidos, nos contratos e nas medições")),
    el("div", { class: "acoes" }, budBotoesExcel("cadastros"))));
  raiz.append(el("div", { class: "kpis" },
    App.kpi("Centros de custo", App.fmt.num(C.centros.length), "core", "cadastrados"),
    App.kpi("Projetos", App.fmt.num(C.projetos.length), "p900", `${C.projetos.filter((p) => p.centro_custo).length} ligados a um centro de custo`),
    App.kpi("Classes financeiras", App.fmt.num(C.classes.length), "p100", "nº e descrição")));
  const usos = (x) => x.n_linhas ? el("span", { class: "etiqueta" }, `${x.n_linhas} linha(s)`) : el("span", { class: "ajuda" }, "não usado");
  const cartao = (tipo, colunas, lista) => App.cartao(BUD_CAD[tipo].titulo, `${lista.length} cadastrado(s) · clique para editar`,
    el("div", { class: "linha-acoes", style: { marginTop: 0, marginBottom: "10px" } }, App.btnEditor(`+ ${BUD_CAD[tipo].novo}`, () => budEditarCadastro(tipo, {}), "btn btn--mini")),
    App.tabela(colunas, lista, { onClick: App.meta.editavel ? (x) => budEditarCadastro(tipo, x) : null, ordem: { i: 0, dir: 1 }, vazio: "Nada cadastrado ainda.",
      selecao: App.meta.editavel ? { id: (x) => x.id, nome: BUD_CAD[tipo].um.replace(/^(\S+)/, "$1(s)"),
        acoes: (ids) => [el("button", { class: "btn btn--mini btn--perigo", onclick: () => budExcluirCadastros(tipo, lista.filter((x) => ids().includes(x.id))) }, "Excluir selecionados")] } : null }));
  raiz.append(el("div", { class: "grade g-12" },
    el("div", { class: "s-6" }, cartao("centros", [
      { rotulo: "Nº", valor: (x) => x.nome, render: (x) => el("b", {}, x.nome) },
      { rotulo: "Descrição", valor: (x) => x.descricao, render: (x) => el("div", { class: "celula-2l" }, el("span", {}, x.descricao || "—"), x.observacao ? el("small", {}, x.observacao) : null) },
      { rotulo: "Uso", valor: (x) => x.n_linhas, render: usos }], C.centros)),
    el("div", { class: "s-6" }, cartao("classes", [
      { rotulo: "Nº", valor: (x) => x.numero, render: (x) => el("b", {}, x.numero) },
      { rotulo: "Descrição", valor: (x) => x.descricao, render: (x) => x.descricao || "—" },
      { rotulo: "Uso", valor: (x) => x.n_linhas, render: usos }], C.classes)),
    el("div", { class: "s-12" }, cartao("projetos", [
      { rotulo: "Nº", valor: (x) => x.nome, render: (x) => el("b", {}, x.nome) },
      { rotulo: "Descrição", valor: (x) => x.descricao, render: (x) => el("div", { class: "celula-2l" }, el("span", {}, x.descricao || "—"), x.observacao ? el("small", {}, x.observacao) : null) },
      { rotulo: "Centro de custo", valor: (x) => x.centro_custo, render: (x) => x.centro_custo ? el("span", { title: App.bud.rotCc(x.centro_custo) }, x.centro_custo) : el("span", { class: "ajuda" }, "qualquer") },
      { rotulo: "Uso", valor: (x) => x.n_linhas, render: usos }], C.projetos))));
  raiz.append(el("p", { class: "ajuda", style: { marginTop: "14px" } },
    "Centro de custo e projeto têm Nº + descrição (o Nº é o que liga as linhas do budget). Mudar o Nº muda em todas as linhas do budget, pedidos, contratos e medições que o usam. Para excluir algo em uso, o site pergunta se quer transferir tudo para outro ou excluir e deixar sem classe. ",
    "Ao importar o budget ou pedidos, centros de custo, projetos e classes novos entram aqui automaticamente."));
}

function budEditarCadastro(tipo, x) {
  const novo = !x.id;
  const cfg = BUD_CAD[tipo];
  const msg = el("p", { class: "ajuda", style: { color: "var(--perigo)", minHeight: "18px" } });
  const campos = {};
  const inp = (k, ph = "") => (campos[k] = el("input", { type: "text", value: x[k] || "", placeholder: ph }));
  let corpo;
  if (tipo === "centros") corpo = [el("label", { class: "campo" }, el("span", {}, "Nº do centro de custo"), inp("nome", "ex.: 9010")),
    el("label", { class: "campo", style: { gridColumn: "span 2" } }, el("span", {}, "Descrição"), inp("descricao", "ex.: MANUTENÇÃO")),
    el("label", { class: "campo campo--largo" }, el("span", {}, "Observação"), inp("observacao"))];
  else if (tipo === "projetos") {
    campos.centro_custo = el("select", {}, el("option", { value: "" }, "Qualquer centro de custo"),
      App.bud.base.cadastros.centros.map((c) => el("option", { value: c.nome, selected: c.nome === x.centro_custo }, App.bud.rotCc(c.nome))));
    corpo = [el("label", { class: "campo" }, el("span", {}, "Nº do projeto"), inp("nome", "ex.: 1002")),
      el("label", { class: "campo", style: { gridColumn: "span 2" } }, el("span", {}, "Descrição"), inp("descricao", "ex.: EVENTOS")),
      el("label", { class: "campo campo--largo" }, el("span", {}, "Centro de custo (opcional: o projeto só aparece para ele)"), campos.centro_custo),
      el("label", { class: "campo campo--largo" }, el("span", {}, "Observação"), inp("observacao"))];
  } else corpo = [el("label", { class: "campo" }, el("span", {}, "Nº da classe"), inp("numero", "ex.: 4.1.01")),
    el("label", { class: "campo", style: { gridColumn: "span 2" } }, el("span", {}, "Descrição"), inp("descricao", "ex.: MATERIAL DE MANUTENÇÃO"))];
  App.modal(el("div", { class: "modal--largo" }, el("h3", {}, novo ? cfg.novo : `Editar ${cfg.um}`),
    el("div", { class: "grade-form" }, corpo),
    !novo && x.n_linhas ? el("p", { class: "ajuda" }, `Em uso em ${x.n_linhas} linha(s) do budget. Se mudar o Nº, muda em todo lugar.`) : null,
    msg,
    el("div", { class: "linha-acoes" },
      el("button", { class: "btn", onclick: async () => {
        const json = { id: x.id };
        Object.entries(campos).forEach(([k, c]) => (json[k] = c.value));
        try {
          await App.api(`/api/budget/cadastros/${tipo}`, { method: "POST", json });
          App.fecharModal(); App.toast("Salvo."); App.rotear();
        } catch (e) { msg.textContent = e.message; }
      } }, "Salvar"),
      el("button", { class: "btn btn--linha", "data-fechar": "" }, "Cancelar"),
      novo ? null : el("button", { class: "btn btn--perigo", style: { marginLeft: "auto" }, onclick: () => budExcluirCadastro(tipo, x) }, "Excluir"))));
}

/** Excluir centro de custo / projeto / classe (um ou vários). Em uso: transferir tudo para outro ou excluir e deixar sem classe. */
const budExcluirCadastro = (tipo, x) => budExcluirCadastros(tipo, [x]);
async function budExcluirCadastros(tipo, xs) {
  if (!xs.length) return;
  const cfg = BUD_CAD[tipo];
  const ids = xs.map((x) => x.id);
  const x = xs.length === 1 ? xs[0] : { [cfg.chave]: `${xs.length} itens` };
  const nome = xs.length === 1 ? `${x[cfg.chave]}${x.descricao ? " — " + x.descricao : ""}` : xs.map((y) => y[cfg.chave]).join(", ");
  let u;
  try { u = await App.api(`/api/budget/cadastros/${tipo}/uso`, { method: "POST", json: { ids } }); } catch (e) { App.toast(e.message, true); return; }
  const excluir = async (qs, ok) => {
    const p = new URLSearchParams(qs.replace(/^\?/, ""));
    try { await App.api(`/api/budget/cadastros/${tipo}/excluir`, { method: "POST", json: { ids, modo: p.get("modo") || "", para: p.get("para") || "" } });
      App.fecharModal(); App.toast(ok); App.rotear(); }
    catch (e) { App.toast(e.message, true); }
  };
  if (!u.total) {
    if (!(await App.confirmar("Excluir", `Excluir “${nome}” da lista?`, "Excluir"))) return;
    return excluir("", xs.length > 1 ? `${xs.length} excluídos.` : "Excluído.");
  }
  const U = u.uso;
  const partes = [[U.linhas_budget, "linha(s) do budget"], [U.pedidos, "pedido(s)"], [U.medicoes, "medição(ões)"], [U.contratos, "contrato(s) / linha(s) de contrato"],
    [u.projetos, "projeto(s) ligado(s) a este centro de custo"]].filter(([n]) => n).map(([n, t]) => `${n} ${t}`);
  const lista = App.bud.base.cadastros[tipo].filter((o) => !ids.includes(o.id));
  const sel = el("select", {}, el("option", { value: "" }, "Escolha…"),
    lista.map((o) => el("option", { value: o[cfg.chave] }, `${o[cfg.chave]}${o.descricao ? " — " + o.descricao : ""}`)));
  const msg = el("p", { class: "ajuda", style: { color: "var(--perigo)", minHeight: "16px" } });
  App.modal(el("div", { class: "modal--largo" }, el("h3", {}, xs.length > 1 ? `Excluir ${xs.length} itens (${cfg.titulo.toLowerCase()})` : `Excluir ${cfg.um} “${x[cfg.chave]}”`),
    el("p", {}, `${xs.length > 1 ? "Juntos, “" + nome + "”" : "“" + nome + "”"} estão em uso: ${partes.join(", ")}. Escolha o que fazer:`.replace(/^“([^”]*)” estão/, "“$1” está")),
    el("div", { class: "opcao-exclusao" },
      el("b", {}, "Transferir tudo para outro e excluir"),
      el("p", { class: "ajuda" }, "Linhas do budget, pedidos, medições e contratos passam para o escolhido. Se a mesma linha já existir lá, os valores do budget são somados."),
      el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } }, sel,
        el("button", { class: "btn", onclick: () => { if (!sel.value) { msg.textContent = "Escolha para onde transferir."; return; }
          excluir(`?modo=transferir&para=${encodeURIComponent(sel.value)}`, `Transferido para ${sel.value} e excluído.`); } }, "Transferir e excluir"))),
    el("div", { class: "opcao-exclusao opcao-exclusao--perigo" },
      el("b", {}, "Excluir e deixar sem classe"),
      el("p", { class: "ajuda" }, "Apaga as linhas do budget que usam este cadastro (com os valores). Pedidos, medições e contratos continuam no site, mas ficam sem classe financeira até você escolher outra."),
      el("button", { class: "btn btn--perigo", onclick: async () => {
        if (!(await App.confirmar("Excluir mesmo assim", `Excluir “${nome}” e tirar de ${partes.join(", ")}?`, "Excluir"))) return;
        excluir("?modo=desvincular", "Excluído. O que usava este cadastro ficou sem classe.");
      } }, "Excluir e deixar sem classe")),
    msg,
    el("div", { class: "linha-acoes" }, el("button", { class: "btn btn--linha", "data-fechar": "" }, "Cancelar"))));
}

/* ------------------------------------------------------------------ PEDIDO LIDO DO PDF */
function budBotaoPdf() {
  const inp = el("input", { type: "file", accept: ".pdf", multiple: true, hidden: true });
  inp.onchange = () => { budLerPdfs([...inp.files]); inp.value = ""; };
  return [inp, App.btnEditor("Ler PDF do pedido", () => inp.click(), "btn btn--sec")];
}

/** Lê os PDFs, mostra o que achou para conferir (nº, fornecedor, CNPJ, data, valor, projeto…) e grava. */
async function budLerPdfs(files) {
  if (!files.length) return;
  App.toast(`Lendo ${files.length} PDF(s)…`);
  const fd = new FormData();
  files.forEach((f) => fd.append("arquivo", f, f.name));
  let lidos;
  try {
    const r = await fetch("/api/budget/pedidos/ler-pdf", { method: "POST", body: fd });
    lidos = await r.json();
    if (!r.ok) throw new Error(lidos.erro || `Erro ${r.status}`);
  } catch (e) { App.toast(e.message, true); return; }
  const C = App.bud.base.cadastros;
  // projetos do PDF que ainda não estão nos Cadastros entram na lista (são cadastrados ao salvar)
  lidos.forEach((d) => {
    if (d.projeto_numero && !C.projetos.some((p) => p.nome === d.projeto_numero)) {
      C.projetos.push({ nome: d.projeto_numero, descricao: d.projeto_descricao, centro_custo: "", novo: true });
      App.bud.desc.pj[d.projeto_numero] = (d.projeto_descricao || "") + " (novo)";
    }
  });
  const cartoes = lidos.map((d, i) => {
    const f = files.find((x) => x.name === d.arquivo) || files[i];
    if (d.erro) return { el: el("div", { class: "item-contrato" }, el("b", {}, "" + d.arquivo), el("div", { class: "aviso-budget aviso-budget--alerta" }, d.erro)) };
    const ex = d.existe;
    const inp = (v, extra = {}) => el("input", { type: "text", value: v ?? "", ...extra });
    const c = {
      usar: el("input", { type: "checkbox", checked: true, style: { width: "auto", margin: 0 } }),
      numero: inp(d.numero), data: el("input", { type: "date", value: d.data_emissao || "" }),
      valor: el("input", { type: "number", step: "0.01", value: d.valor ?? "" }),
      fornecedor: inp(d.fornecedor), cnpj: inp(d.cnpj), processo: inp(d.processo),
      motivo: el("select", {}, el("option", { value: "" }, "Escolha…"), App.bud.base.motivos.map((m) => el("option", { value: m, selected: m === d.motivo }, m.charAt(0) + m.slice(1).toLowerCase()))),
      descricao: el("textarea", { rows: 2 }, d.descricao || ""),
    };
    c.cps = App.bud.camposClasse({ projeto: d.projeto_numero || "", centro_custo: d.centro_custo_projeto || "", classe_numero: "" },
      { ano: () => (c.data.value || "").slice(0, 4), vazio: "—" });
    const lab = (t, x, extra = {}) => el("label", { class: "campo", ...extra }, el("span", {}, t), x);
    const corpo = el("div", { class: "item-contrato", style: { padding: "12px" } },
      el("div", { style: { display: "flex", gap: "10px", alignItems: "center", marginBottom: "8px", flexWrap: "wrap" } }, c.usar,
        el("b", {}, `Pedido ${d.numero || "?"}`), el("span", { class: "ajuda" }, "" + d.arquivo),
        ex ? el("span", { class: "etiqueta etiqueta--aviso", title: "Só os campos vazios no site serão completados" }, "já existe — vai completar o que falta")
          : el("span", { class: "etiqueta etiqueta--ok" }, "novo"),
        d.rm ? el("span", { class: "etiqueta" }, `RM ${d.rm}`) : null),
      d.avisos && d.avisos.length ? el("div", { class: "aviso-budget aviso-budget--alerta", style: { marginBottom: "8px" } }, d.avisos.join(" ")) : null,
      el("div", { class: "grade-form" },
        lab("Nº do pedido", c.numero), lab("Data de emissão", c.data), lab("Valor total (R$)", c.valor),
        lab("Fornecedor", c.fornecedor, { style: { gridColumn: "span 2" } }), lab("CNPJ", c.cnpj),
        lab("Processo nº", c.processo), lab("Motivo (sugerido)", c.motivo), el("div", {}),
        c.cps.campos(), el("div", { class: "campo campo--largo" }, c.cps.aviso,
          el("p", { class: "ajuda", style: { margin: "2px 0 0" } }, "Sem classe agora? Pode deixar: o projeto fica guardado e a planilha de pedidos completa depois.")),
        lab("Descrição (itens do pedido)", c.descricao, { class: "campo campo--largo" })));
    return { el: corpo, d, c, f };
  });
  const msg = el("p", { class: "ajuda", style: { color: "var(--perigo)", minHeight: "18px" } });
  App.modal(el("div", { class: "modal--largo", style: { maxWidth: "980px" } }, el("h3", {}, `Pedidos lidos do PDF (${lidos.length})`),
    el("p", { class: "ajuda", style: { marginTop: 0 } }, "Confira o que foi lido. O PDF vira o anexo do pedido. Pedido que já existe só tem os campos vazios completados."),
    el("div", { class: "itens-contrato" }, cartoes.map((x) => x.el)), msg,
    el("div", { class: "linha-acoes" },
      el("button", { class: "btn", onclick: async (ev) => {
        ev.target.disabled = true;
        let ok = 0, erros = [];
        for (const x of cartoes.filter((x) => x.c && x.c.usar.checked)) {
          const c = x.c, v = c.cps.valores();
          const pj = App.bud.base.cadastros.projetos.find((p) => p.nome === v.projeto);
          const dados = { numero: c.numero.value, data_emissao: c.data.value, valor: c.valor.value, fornecedor: c.fornecedor.value, cnpj: c.cnpj.value,
            processo: c.processo.value, motivo: c.motivo.value, descricao: c.descricao.value, cotacao: x.d.cotacao || "",
            projeto: v.projeto, projeto_descricao: pj && pj.novo ? pj.descricao : "", centro_custo: v.centro_custo, classe_numero: v.classe_numero };
          const fd = new FormData();
          fd.append("dados", JSON.stringify(dados));
          if (x.f) fd.append("arquivo", x.f, x.f.name);
          try {
            const r = await fetch("/api/budget/pedidos/pdf", { method: "POST", body: fd });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.erro || `Erro ${r.status}`);
            ok++;
          } catch (e) { erros.push(`${dados.numero || x.d.arquivo}: ${e.message}`); }
        }
        if (erros.length) { msg.textContent = erros.join(" · "); ev.target.disabled = false; return; }
        App.fecharModal(); App.toast(`${ok} pedido(s) salvo(s).`); App.rotear();
      } }, "Salvar pedidos"),
      el("button", { class: "btn btn--linha", "data-fechar": "", onclick: () => App.bud.carregarBase() }, "Cancelar"))));
}

/* ------------------------------------------------------------------ LANÇAR SOLICITADO / APROVADO */
/** Uma tela com todas as linhas do ano (cada classe de cada projeto/centro de custo) para digitar solicitado e aprovado de uma vez.
    Já aparecem as linhas do budget, as que têm gasto e as dos itens de contrato. */
async function budLancarPrevistos(ano) {
  const linhas = await App.api(`/api/budget/previstos?ano=${ano}`);
  const busca = el("input", { type: "search", placeholder: "Filtrar por projeto, centro de custo ou classe…" });
  const mostrar = el("select", { style: { width: "auto" } }, [["", "Todas"], ["sem_sol", "Sem solicitado"], ["sem_apr", "Sem aprovado"], ["no_budget", "Só as que já estão no budget"], ["fora", "Só as que não estão no budget"]]
    .map(([v, r]) => el("option", { value: v }, r)));
  const entradas = [];
  const tbody = el("tbody");
  const totSol = el("b"), totApr = el("b"), totDif = el("b");
  const somar = () => {
    const sSol = entradas.reduce((s, e) => s + (+e.sol.value || 0), 0), sApr = entradas.reduce((s, e) => s + (+e.apr.value || 0), 0);
    const dif = entradas.filter((e) => e.sol.value !== "" && e.apr.value !== "").reduce((s, e) => s + (+e.apr.value - +e.sol.value), 0);
    totSol.textContent = App.fmt.brl(sSol); totApr.textContent = App.fmt.brl(sApr);
    totDif.textContent = (dif < 0 ? "− " : "") + App.fmt.brl(Math.abs(dif)); totDif.style.color = dif < 0 ? "var(--perigo)" : "";
  };
  const linhaTr = (l) => {
    const campo = (v) => el("input", { type: "number", step: "0.01", min: "0", value: v ?? "", placeholder: "—", style: { width: "118px", textAlign: "right" } });
    const e = { l, sol: campo(l.solicitado), apr: campo(l.aprovado), dif: el("span") };
    const dif = () => {
      if (e.sol.value === "" || e.apr.value === "") { e.dif.textContent = "—"; e.dif.style.color = ""; return; }
      const d = +e.apr.value - +e.sol.value;
      e.dif.textContent = (d < 0 ? "− " : d > 0 ? "+ " : "") + App.fmt.brl(Math.abs(d)); e.dif.style.color = d < 0 ? "var(--perigo)" : "";
    };
    [e.sol, e.apr].forEach((i) => i.addEventListener("input", () => { dif(); somar(); }));
    dif(); entradas.push(e);
    const tr = el("tr", { class: l.no_budget ? "" : "linha-fora" },
      el("td", {}, el("div", { class: "celula-2l" }, el("b", {}, `Projeto ${l.projeto || "—"}`), el("small", {}, `CC ${App.bud.rotCc(l.centro_custo) || "—"}`))),
      el("td", {}, el("div", { class: "celula-2l" }, el("b", {}, l.classe_numero), el("small", {}, l.classe_descricao || "")),
        l.no_budget ? null : el("span", { class: "etiqueta etiqueta--aviso", style: { marginTop: "2px" } }, "fora do budget")),
      el("td", { class: "num" }, l.gasto ? App.fmt.brl(l.gasto) : "—"),
      el("td", { class: "num" }, e.sol), el("td", { class: "num" }, e.apr), el("td", { class: "num" }, e.dif));
    tr._texto = App.norm(`${App.bud.rotPj(l.projeto)} ${App.bud.rotCc(l.centro_custo)} ${l.classe_numero} ${l.classe_descricao}`);
    tr._e = e;
    return tr;
  };
  const trs = linhas.map(linhaTr);
  tbody.append(...trs);
  const filtrar = () => {
    const q = App.norm(busca.value), m = mostrar.value;
    trs.forEach((tr) => {
      const e = tr._e;
      const ok = { sem_sol: e.sol.value === "", sem_apr: e.apr.value === "", no_budget: e.l.no_budget, fora: !e.l.no_budget }[m] ?? true;
      tr.hidden = (q && !tr._texto.includes(q)) || !ok;
    });
  };
  busca.oninput = filtrar; mostrar.onchange = filtrar;
  somar();
  const msg = el("p", { class: "ajuda", style: { color: "var(--perigo)", minHeight: "18px" } });
  App.modal(el("div", { class: "modal--largo", class: "modal--extra" }, el("h3", {}, `Lançar solicitado e aprovado · ${ano}`),
    el("p", { class: "ajuda", style: { marginTop: 0 } }, "Solicitado = valor pedido pela gestora · Aprovado = valor aprovado pela controladoria. Cada classe de cada projeto / centro de custo tem os seus valores. ",
      "Apagar um valor e salvar tira esse valor da linha. Falta alguma combinação? Use “+ Linha” ou a guia BUDGET da planilha de importação."),
    el("div", { style: { display: "flex", gap: "12px", alignItems: "center", margin: "8px 0", flexWrap: "wrap" } },
      el("div", { class: "busca", style: { flex: 1, minWidth: "240px" } }, busca),
      el("label", { style: { display: "flex", gap: "6px", alignItems: "center", fontSize: "16px" } }, "Mostrar", mostrar)),
    linhas.length ? el("div", { class: "tabela-wrap", style: { maxHeight: "55vh" } }, el("table", { class: "tabela tabela--budget" },
      el("thead", {}, el("tr", {}, ["Projeto / centro de custo", "Classe financeira", `Incorrido em ${ano}`, "Solicitado (R$)", "Aprovado (R$)", "Aprov. − solic."].map((c, i) => el("th", { class: i >= 2 ? "num" : "" }, c)))),
      tbody, el("tfoot", {}, el("tr", {}, el("td", { colspan: 3 }, "Total"), el("td", { class: "num" }, totSol), el("td", { class: "num" }, totApr), el("td", { class: "num" }, totDif)))))
      : el("div", { class: "cartao vazio" }, "Nenhuma combinação conhecida ainda. Cadastre os itens dos contratos ou use “+ Linha”."),
    msg,
    el("div", { class: "linha-acoes" },
      el("button", { class: "btn", onclick: async () => {
        const muda = (inp, antes) => {
          if (inp.value === "") return antes != null ? "-" : null;
          return antes != null && +inp.value === +antes ? null : inp.value;
        };
        const valores = entradas.map((e) => ({ item_id: e.l.item_id, solicitado: muda(e.sol, e.l.solicitado), aprovado: muda(e.apr, e.l.aprovado) }))
          .filter((v) => v.solicitado !== null || v.aprovado !== null);
        if (!valores.length) { msg.textContent = "Nada mudou."; return; }
        try {
          const r = await App.api("/api/budget/previstos", { method: "POST", json: { ano, valores } });
          App.fecharModal(); App.toast(`Valores salvos em ${r.n} linha(s).`); App.rotear();
        } catch (e) { msg.textContent = e.message; }
      } }, "Salvar"),
      el("button", { class: "btn btn--linha", "data-fechar": "" }, "Cancelar"))));
}
