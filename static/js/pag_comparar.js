/* Página: Comparar dois dias de evento (ex.: FESTIVAL DEMO 01/10 x FESTIVAL DEMO 02/10). */
"use strict";

App.paginas.comparar = async function (raiz, params) {
  if (params[0] === "periodos") return App.compararPeriodos(raiz);
  let idA = params[0] ? +params[0] : null, idB = params[1] ? +params[1] : null;
  const porId = (id) => App.eventos.find((e) => e.id === id);
  // sugestão inicial: o evento mais recente que tem outro dia com o mesmo nome
  if (!idA) {
    const repetidos = App.eventos.filter((e) => App.eventos.some((o) => o.nome === e.nome && o.id !== e.id));
    if (repetidos.length) {
      idA = repetidos[0].id;
      idB = App.eventos.find((o) => o.nome === repetidos[0].nome && o.id !== idA)?.id;
    }
  }
  App.aplicarTema(App.ehJogo(porId(idA), porId(idB)));
  const ir = () => (location.hash = `#/comparar/${idA || ""}${idB ? "/" + idB : ""}`);
  const sA = App.seletorEvento({ valor: porId(idA), placeholder: "Escolha o evento A…", onSelect: (e) => { idA = e?.id; ir(); } });
  const sB = App.seletorEvento({ valor: porId(idB), placeholder: "Escolha o evento B…", onSelect: (e) => { idB = e?.id; ir(); } });
  const trocar = el("button", { class: "btn btn--linha btn--mini", title: "Inverter A e B" }, "Inverter");
  trocar.onclick = () => { [idA, idB] = [idB, idA]; ir(); };

  const sugestoes = el("div", { class: "sugestoes" });
  const eA = porId(idA);
  if (eA) {
    const mesmos = App.eventos.filter((o) => o.nome === eA.nome && o.id !== eA.id);
    const parecidos = App.eventos.filter((o) => o.id !== eA.id && o.categoria === eA.categoria && o.genero === eA.genero && o.nome !== eA.nome).slice(0, 4);
    if (mesmos.length || parecidos.length) {
      sugestoes.append(el("span", {}, "Sugestões para B:"));
      [...mesmos, ...parecidos].forEach((o) => sugestoes.append(
        el("button", { class: "chip chip--mini", "aria-pressed": String(o.id === idB), onclick: () => { idB = o.id; ir(); } },
          `${o.nome === eA.nome ? "Mesmo evento" : o.nome} · ${App.fmt.dataCurta(o.data)}`)));
    }
  }

  const corpo = el("div");
  raiz.append(
    el("div", { class: "pagina-cabecalho" },
      el("div", {}, el("h2", {}, "Comparar"), el("p", {}, "Dois dias de evento lado a lado: custos, avarias e chamados"))),
    App.modoComparar("eventos"),
    el("div", { class: "cartao", style: { marginBottom: "16px" } },
      el("div", { class: "comparar-seletores" },
        el("label", { class: "campo" }, el("span", {}, el("i", { class: "marcador", style: { background: App.cores.A } }), "Evento A"), sA),
        el("div", { class: "vs" }, "vs"),
        el("label", { class: "campo" }, el("span", {}, el("i", { class: "marcador", style: { background: App.cores.B } }), "Evento B"), sB)),
      el("div", { class: "linha-acoes", style: { marginTop: "6px" } }, sugestoes, el("span", { style: { marginLeft: "auto" } }, trocar))),
    corpo);

  if (!idA || !idB) { corpo.append(el("div", { class: "cartao vazio" }, "Escolha os dois eventos acima para comparar.")); return; }
  const [a, b] = await Promise.all([App.api(`/api/eventos/${idA}`), App.api(`/api/eventos/${idB}`)]);
  const CA = App.cores.A, CB = App.cores.B;
  const rot = (e) => `${e.nome} · ${App.fmt.dataCurta(e.data)}`;
  const delta = (va, vb) => vb - va;
  const pct = (va, vb) => (va ? 100 * (vb - va) / va : null);
  const fmtDelta = (d) => (d > 0 ? "+" : d < 0 ? "−" : "") + App.fmt.brl(Math.abs(d));
  const fmtPct = (p) => (p === null ? "—" : (p > 0 ? "+" : "") + App.fmt.pct(p));
  const ladoA = { rotulo: rot(a), cor: CA, n: 1, avarias: a.itens.filter((i) => i.tipo === "AVARIAS"), chamados: a.chamados, eventos: [a] };
  const ladoB = { rotulo: rot(b), cor: CB, n: 1, avarias: b.itens.filter((i) => i.tipo === "AVARIAS"), chamados: b.chamados, eventos: [b] };
  App.abasComparacao(corpo, {
    custos: (alvo) => custosEventos(alvo),
    avarias: (alvo) => App.compararAvarias(alvo, ladoA, ladoB),
    chamados: (alvo) => App.compararChamados(alvo, ladoA, ladoB, { extras: [
      ["Técnicos transp. vertical", App.fmt.num(a.tecnicos_tv), App.fmt.num(b.tecnicos_tv)],
      ["Técnico medição acústica", App.fmt.num(a.acustica), App.fmt.num(b.acustica)]] }),
  });

  function custosEventos(alvo) {

  /* ---- placar */
  const d = delta(a.total, b.total), p = pct(a.total, b.total);
  alvo.append(el("div", { class: "kpis" },
    App.kpi(rot(a), App.fmt.brlCurto(a.total), "core", `MDO ${App.fmt.brlCurto(a.mdo)} · Medidores ${App.fmt.brlCurto(a.relogios)}`, "Custo total do evento A: medidores + mão de obra + avarias + insumos."),
    App.kpi(rot(b), App.fmt.brlCurto(b.total), "g900", `MDO ${App.fmt.brlCurto(b.mdo)} · Medidores ${App.fmt.brlCurto(b.relogios)}`, "Custo total do evento B: medidores + mão de obra + avarias + insumos."),
    App.kpi("Diferença (B − A)", fmtDelta(d), d > 0 ? "p900" : "g200", fmtPct(p) + (d > 0 ? " · B custou mais" : d < 0 ? " · B custou menos" : "")),
    App.kpi("Chamados A · B", `${a.chamados.length} · ${b.chamados.length}`, "p100",
      `tempo médio ${App.fmt.min(a.tempo_medio)} · ${App.fmt.min(b.tempo_medio)}`)));

  /* ---- por componente */
  const comps = [
    ["Energia", "eletrica"], ["Água", "agua"], ["Gás", "gas"], ["Poço", "poco"], ["Irrigação (já na água)", "irrigacao"],
    ["MDO", "mdo"], ["Avarias", "avarias"], ["Insumos", "insumos"],
  ].filter(([, k]) => a[k] || b[k]);
  const a1 = G.area("grafico");
  const tabComp = App.tabela([
    { rotulo: "Componente", valor: (c) => c[0], render: (c) => el("b", {}, c[0]) },
    { rotulo: "A", num: true, valor: (c) => a[c[1]], render: (c) => App.fmt.brl(a[c[1]]), total: () => App.fmt.brl(a.total) },
    { rotulo: "B", num: true, valor: (c) => b[c[1]], render: (c) => App.fmt.brl(b[c[1]]), total: () => App.fmt.brl(b.total) },
    { rotulo: "Diferença", num: true, valor: (c) => delta(a[c[1]], b[c[1]]), render: (c) => cor(delta(a[c[1]], b[c[1]]), fmtDelta), total: () => cor(d, fmtDelta) },
    { rotulo: "%", num: true, valor: (c) => pct(a[c[1]], b[c[1]]), render: (c) => cor(pct(a[c[1]], b[c[1]]), fmtPct), total: () => cor(p, fmtPct) },
  ], comps, { rodape: true });
  alvo.append(el("div", { class: "grade g-12" },
    el("div", { class: "s-6" }, App.cartao("Custo por componente", "", G.legenda([[rot(a), CA], [rot(b), CB]]), el("div", { style: { height: "8px" } }), a1.div)),
    el("div", { class: "s-6" }, App.cartao("Diferenças", "positivo = B mais caro que A", tabComp))));
  G.barrasAgrupadas(a1.canvas, comps.map((c) => c[0]), [
    { rotulo: rot(a), cor: CA, valores: comps.map((c) => a[c[1]]) },
    { rotulo: rot(b), cor: CB, valores: comps.map((c) => b[c[1]]) },
  ]);

  /* ---- medidores: consumo físico */
  const un = { "ÁGUA": "m³", "GÁS": "m³", "ELÉTRICA": "kWh", "POÇO": "m³", "IRRIGAÇÃO": "m³" };
  const tipos = ["ELÉTRICA", "ÁGUA", "GÁS", "POÇO", "IRRIGAÇÃO"].filter((t) => a.relogios_lista.some((r) => r.tipo === t) || b.relogios_lista.some((r) => r.tipo === t));
  const cons = (e, t) => e.relogios_lista.find((r) => r.tipo === t)?.consumo ?? null;
  const cartaoRel = tipos.length ? App.cartao("Consumo dos medidores", "leituras físicas",
    App.tabela([
      { rotulo: "Medidor", valor: (t) => t, render: (t) => el("span", { class: "etiqueta" }, el("i", { style: { background: App.cores.relogio[t] } }), t) },
      { rotulo: "A", num: true, valor: (t) => cons(a, t), render: (t) => cons(a, t) === null ? "—" : `${App.fmt.num(cons(a, t))} ${un[t]}` },
      { rotulo: "B", num: true, valor: (t) => cons(b, t), render: (t) => cons(b, t) === null ? "—" : `${App.fmt.num(cons(b, t))} ${un[t]}` },
      { rotulo: "%", num: true, valor: (t) => pct(cons(a, t), cons(b, t)), render: (t) => cor(pct(cons(a, t), cons(b, t)), fmtPct) },
    ], tipos)) : null;

  /* ---- energia por hora sobreposta */
  let cartaoEn = null, aE = null;
  if (a.energia.length || b.energia.length) {
    aE = G.area("grafico");
    cartaoEn = App.cartao("Energia por hora", "kWh · hora a hora", G.legenda([[rot(a), CA], [rot(b), CB]], true), el("div", { style: { height: "8px" } }), aE.div);
  }
  if (cartaoRel || cartaoEn) {
    alvo.append(el("div", { class: "grade g-12", style: { marginTop: "16px" } },
      cartaoRel ? el("div", { class: cartaoEn ? "s-5" : "s-12" }, cartaoRel) : null,
      cartaoEn ? el("div", { class: cartaoRel ? "s-7" : "s-12" }, cartaoEn) : null));
  }
  if (aE) {
    const n = Math.max(a.energia.length, b.energia.length);
    const rotulos = Array.from({ length: n }, (_, i) => (a.energia[i] || b.energia[i]).hora);
    G.linha(aE.canvas, rotulos, [
      { rotulo: rot(a), cor: CA, valores: rotulos.map((_, i) => a.energia[i]?.consumo ?? null) },
      { rotulo: rot(b), cor: CB, valores: rotulos.map((_, i) => b.energia[i]?.consumo ?? null) },
    ], { fmt: (v) => App.fmt.num(v) + " kWh" });
  }

  /* ---- itens lado a lado */
  const chave = (i) => `${i.tipo}|${i.item}`;
  const mapa = {};
  for (const [lado, e] of [["a", a], ["b", b]]) {
    for (const i of e.itens) {
      const m = (mapa[chave(i)] = mapa[chave(i)] || { tipo: i.tipo, item: i.item, qa: 0, qb: 0, va: 0, vb: 0 });
      m["q" + lado] += i.qtd; m["v" + lado] += i.total;
    }
  }
  const linhasItens = Object.values(mapa);
  alvo.append(el("div", { class: "grade", style: { marginTop: "16px" } },
    App.cartao("Itens lado a lado", `${linhasItens.length} itens diferentes`,
      App.tabela([
        { rotulo: "Tipo", valor: (r) => r.tipo, render: (r) => el("span", { class: "etiqueta" }, el("i", { style: { background: App.cores.componente[r.tipo] || App.cores.componente.AVARIAS } }), r.tipo) },
        { rotulo: "Item", valor: (r) => r.item },
        { rotulo: "Qtd. A", num: true, valor: (r) => r.qa, render: (r) => App.fmt.num(r.qa) },
        { rotulo: "Qtd. B", num: true, valor: (r) => r.qb, render: (r) => App.fmt.num(r.qb) },
        { rotulo: "Valor A", num: true, valor: (r) => r.va, render: (r) => App.fmt.brl(r.va), total: (l) => App.fmt.brl(App.soma(l, (r) => r.va)) },
        { rotulo: "Valor B", num: true, valor: (r) => r.vb, render: (r) => App.fmt.brl(r.vb), total: (l) => App.fmt.brl(App.soma(l, (r) => r.vb)) },
        { rotulo: "Diferença", num: true, valor: (r) => r.vb - r.va, render: (r) => cor(r.vb - r.va, fmtDelta), total: (l) => cor(App.soma(l, (r) => r.vb - r.va), fmtDelta) },
      ], linhasItens, { rodape: true, ordem: { i: 6, dir: -1 }, vazio: "Nenhum item lançado nos dois eventos." }))));

  /* ---- anexos dos dois dias */
  const anexosResumo = (e) => e.anexos.find((x) => x.resumo && x.resumo.grupos && x.resumo.grupos.length);
  const rA = anexosResumo(a), rB = anexosResumo(b);
  if (rA && rB) {
    const tot = (r, rotulo) => (r.resumo.totais || []).find((t) => t.rotulo === rotulo)?.valor;
    const rotulos = [...new Set([...(rA.resumo.totais || []), ...(rB.resumo.totais || [])].map((t) => t.rotulo))];
    const grupos = [...new Set([...rA.resumo.grupos, ...rB.resumo.grupos].map((g) => g.titulo))];
    const sub = (r, t) => App.soma(r.resumo.grupos.filter((g) => g.titulo === t), (g) => g.subtotal ?? App.soma(g.linhas, (l) => l.valor));
    alvo.append(el("div", { class: "grade", style: { marginTop: "16px" } },
      App.cartao("Custos operacionais (planilhas anexadas)", `${rA.nome_original}  ×  ${rB.nome_original}`,
        App.tabela([
          { rotulo: "Bloco", render: (r) => el("b", {}, r.t) },
          { rotulo: "A", num: true, render: (r) => App.fmt.brl(r.a) },
          { rotulo: "B", num: true, render: (r) => App.fmt.brl(r.b) },
          { rotulo: "Diferença", num: true, render: (r) => cor(r.b - r.a, fmtDelta) },
        ], [...grupos.map((t) => ({ t, a: sub(rA, t), b: sub(rB, t) })),
          ...rotulos.map((t) => ({ t, a: tot(rA, t) || 0, b: tot(rB, t) || 0 }))]))));
  }

  }

  function cor(v, f) {
    if (v === null || v === undefined || Math.abs(v) < 0.005) return el("span", {}, f(v ?? null));
    return el("span", { class: v > 0 ? "pos" : "neg" }, f(v));
  }
};

/* ======================================================================
   Peças compartilhadas da comparação (dois eventos OU dois períodos)
   lado = { rotulo, cor, n (nº de eventos), avarias: [itens], chamados: [...], eventos: [...] }
   ====================================================================== */
App.modoComparar = function (atual) {
  const b = (id, rot, href) => el("a", { class: "chip chip--link", href, "aria-pressed": String(atual === id) }, rot);
  return el("div", { class: "chips", style: { marginBottom: "12px" } },
    b("eventos", "Dois dias de evento", "#/comparar"), b("periodos", "Dois períodos", "#/comparar/periodos"));
};

App.abasComparacao = function (corpo, construtores) {
  let aba = "custos";
  try { aba = localStorage.getItem("rge_aba_comp") || "custos"; } catch (e) { /* ok */ }
  if (!construtores[aba]) aba = Object.keys(construtores)[0];
  const nomes = { custos: "Custos", avarias: "Avarias", chamados: "Chamados" };
  const barra = el("div", { class: "subabas subabas--grandes" });
  const alvo = el("div");
  const abrir = (k) => {
    aba = k;
    try { localStorage.setItem("rge_aba_comp", k); } catch (e) { /* ok */ }
    barra.querySelectorAll("button").forEach((x) => x.classList.toggle("ativa", x.dataset.k === k));
    App.destruirGraficos();
    App.limpar(alvo);
    construtores[k](alvo);
  };
  Object.keys(construtores).forEach((k) => barra.append(el("button", { "data-k": k, onclick: () => abrir(k) }, nomes[k] || k)));
  corpo.append(barra, alvo);
  abrir(aba);
};

const _cmp = {
  delta: (va, vb) => vb - va,
  pct: (va, vb) => (va ? 100 * (vb - va) / va : null),
  fmtDelta: (d) => (d > 0 ? "+" : d < 0 ? "−" : "") + App.fmt.brl(Math.abs(d)),
  fmtDeltaN: (d) => (d > 0 ? "+" : d < 0 ? "−" : "") + App.fmt.num(Math.abs(d)),
  fmtPct: (p) => (p === null || p === undefined ? "—" : (p > 0 ? "+" : "") + App.fmt.pct(p)),
  cor(v, f) {
    if (v === null || v === undefined || Math.abs(v) < 0.005) return el("span", {}, f(v ?? null));
    return el("span", { class: v > 0 ? "pos" : "neg" }, f(v));
  },
};

/* ---------------------------------------------------------------- AVARIAS */
App.compararAvarias = function (alvo, A, B) {
  const { pct, fmtDelta, fmtDeltaN, fmtPct, cor } = _cmp;
  const tot = (L) => App.soma(L.avarias, (i) => i.total), qtd = (L) => App.soma(L.avarias, (i) => i.qtd);
  const tA = tot(A), tB = tot(B), d = tB - tA;
  const porEvento = A.n > 1 || B.n > 1;
  const evComAv = (L) => new Set(L.avarias.map((i) => i.evento_id)).size;
  alvo.append(el("div", { class: "kpis" },
    App.kpi(`Avarias · ${A.rotulo}`, App.fmt.brlCurto(tA), "core", `${App.fmt.num(qtd(A))} itens${porEvento ? ` · ${evComAv(A)} de ${A.n} eventos` : ""}`),
    App.kpi(`Avarias · ${B.rotulo}`, App.fmt.brlCurto(tB), "g900", `${App.fmt.num(qtd(B))} itens${porEvento ? ` · ${evComAv(B)} de ${B.n} eventos` : ""}`),
    App.kpi("Diferença (B − A)", fmtDelta(d), d > 0 ? "p900" : "g200", fmtPct(pct(tA, tB)) + (d > 0 ? " · B teve mais avarias" : d < 0 ? " · B teve menos avarias" : "")),
    porEvento ? App.kpi("Média por evento A · B", `${App.fmt.brlCurto(tA / (A.n || 1))} · ${App.fmt.brlCurto(tB / (B.n || 1))}`, "p100", "valor de avarias ÷ nº de eventos do período") : null));

  if (!A.avarias.length && !B.avarias.length) { alvo.append(el("div", { class: "cartao vazio" }, "Nenhuma avaria lançada nos dois lados.")); return; }

  // junta por item
  const mapa = {};
  for (const [lado, L] of [["a", A], ["b", B]]) {
    for (const i of L.avarias) {
      const m = (mapa[i.item] = mapa[i.item] || { item: i.item, qa: 0, qb: 0, va: 0, vb: 0 });
      m["q" + lado] += i.qtd; m["v" + lado] += i.total;
    }
  }
  const linhas = Object.values(mapa);
  const top = [...linhas].sort((x, y) => Math.max(y.va, y.vb) - Math.max(x.va, x.vb)).slice(0, 15);
  const medida = el("select", {}, el("option", { value: "v" }, "Valor (R$)"), el("option", { value: "q" }, "Quantidade"));
  const g = G.area("grafico");
  g.div.style.height = (top.length * 46 + 50) + "px";
  const cartaoG = App.cartao(`Itens avariados · top ${top.length}`, "A × B por item",
    el("div", { class: "linha-acoes", style: { marginTop: 0, marginBottom: "8px" } }, G.legenda([[A.rotulo, A.cor], [B.rotulo, B.cor]]),
      el("span", { style: { marginLeft: "auto" } }, medida)), g.div);
  const quebrar = (t) => App.quebrar(t, 30);
  const plot = () => {
    if (g.chart) { App.graficos = App.graficos.filter((x) => x !== g.chart); g.chart.destroy(); }
    const v = medida.value;
    g.chart = G.barrasAgrupadas(g.canvas, top.map((x) => quebrar(x.item)), [
      { rotulo: A.rotulo, cor: A.cor, valores: top.map((x) => x[v + "a"]) },
      { rotulo: B.rotulo, cor: B.cor, valores: top.map((x) => x[v + "b"]) },
    ], { horizontal: true, fmt: v === "v" ? App.fmt.brlCurto : (n) => App.fmt.num(n) });
  };
  medida.onchange = plot;

  const so = (r) => (r.qa && !r.qb ? el("span", { class: "etiqueta" }, "só A") : !r.qa && r.qb ? el("span", { class: "etiqueta etiqueta--alerta" }, "só B") : "");
  alvo.append(el("div", { class: "grade" }, cartaoG), el("div", { style: { height: "16px" } }),
    el("div", { class: "grade" }, App.cartao("Avarias lado a lado", `${linhas.length} itens · positivo = B maior que A`,
      App.tabela([
        { rotulo: "Item", valor: (r) => r.item, render: (r) => el("span", {}, r.item, " ", so(r)) },
        { rotulo: "Qtd. A", num: true, valor: (r) => r.qa, render: (r) => App.fmt.num(r.qa), total: (l) => App.fmt.num(App.soma(l, (r) => r.qa)) },
        { rotulo: "Qtd. B", num: true, valor: (r) => r.qb, render: (r) => App.fmt.num(r.qb), total: (l) => App.fmt.num(App.soma(l, (r) => r.qb)) },
        { rotulo: "Δ qtd.", num: true, valor: (r) => r.qb - r.qa, render: (r) => cor(r.qb - r.qa, fmtDeltaN) },
        { rotulo: "Valor A", num: true, valor: (r) => r.va, render: (r) => App.fmt.brl(r.va), total: (l) => App.fmt.brl(App.soma(l, (r) => r.va)) },
        { rotulo: "Valor B", num: true, valor: (r) => r.vb, render: (r) => App.fmt.brl(r.vb), total: (l) => App.fmt.brl(App.soma(l, (r) => r.vb)) },
        { rotulo: "Δ valor", num: true, valor: (r) => r.vb - r.va, render: (r) => cor(r.vb - r.va, fmtDelta), total: (l) => cor(App.soma(l, (r) => r.vb - r.va), fmtDelta) },
      ], linhas, { rodape: true, ordem: { i: 6, dir: -1 } }))));
  plot();
};

/* ---------------------------------------------------------------- CHAMADOS */
App.compararChamados = function (alvo, A, B, { extras = [] } = {}) {
  const { pct, fmtDeltaN, fmtPct, cor } = _cmp;
  const sla = App.meta.sla_minutos;
  const stats = (L) => {
    const t = L.chamados.map((c) => c.tempo).filter((x) => x !== null && x !== undefined);
    return { n: L.chamados.length, media: t.length ? App.soma(t, (x) => x) / t.length : null, max: t.length ? Math.max(...t) : null,
      sla: t.length ? 100 * t.filter((x) => x <= sla).length / t.length : null, porEv: L.n ? L.chamados.length / L.n : 0 };
  };
  const sA = stats(A), sB = stats(B);
  const porEvento = A.n > 1 || B.n > 1;
  alvo.append(el("div", { class: "kpis" },
    App.kpi(`Chamados · ${A.rotulo}`, App.fmt.num(sA.n), "core", porEvento ? `${App.fmt.num(sA.porEv)} por evento · ${A.n} eventos` : `tempo médio ${App.fmt.min(sA.media)}`),
    App.kpi(`Chamados · ${B.rotulo}`, App.fmt.num(sB.n), "g900", porEvento ? `${App.fmt.num(sB.porEv)} por evento · ${B.n} eventos` : `tempo médio ${App.fmt.min(sB.media)}`),
    App.kpi("Diferença (B − A)", fmtDeltaN(sB.n - sA.n), sB.n > sA.n ? "p900" : "g200",
      porEvento ? `por evento: ${fmtPct(pct(sA.porEv, sB.porEv))}` : fmtPct(pct(sA.n, sB.n))),
    App.kpi("Tempo médio A · B", `${App.fmt.min(sA.media)} · ${App.fmt.min(sB.media)}`, "p100", `SLA ${App.fmt.pct(sA.sla)} · ${App.fmt.pct(sB.sla)}`)));

  if (!sA.n && !sB.n) { alvo.append(el("div", { class: "cartao vazio" }, "Nenhum chamado nos dois lados.")); return; }

  const tipos = [...new Set([...A.chamados, ...B.chamados].map((c) => c.tipo || "SEM TIPO"))];
  const cont = (L, t) => L.chamados.filter((c) => (c.tipo || "SEM TIPO") === t).length;
  const med = (L, t) => { const x = L.chamados.filter((c) => (c.tipo || "SEM TIPO") === t && c.tempo !== null && c.tempo !== undefined); return x.length ? App.soma(x, (c) => c.tempo) / x.length : 0; };
  tipos.sort((x, y) => (cont(A, y) + cont(B, y)) - (cont(A, x) + cont(B, x)));
  const norm = porEvento ? el("select", {}, el("option", { value: "evento" }, "Média por evento"), el("option", { value: "total" }, "Total do período")) : null;
  const g1 = G.area("grafico"); g1.div.style.height = Math.max(240, tipos.length * 46 + 30) + "px";
  const g2 = G.area("grafico"); g2.div.style.height = Math.max(240, tipos.length * 46 + 30) + "px";
  const leg = () => G.legenda([[A.rotulo, A.cor], [B.rotulo, B.cor]]);
  alvo.append(el("div", { class: "grade g-12" },
    el("div", { class: "s-6" }, App.cartao("Chamados por tipo", porEvento ? "quantidade (média por evento ou total)" : "quantidade",
      el("div", { class: "linha-acoes", style: { marginTop: 0, marginBottom: "8px" } }, leg(), norm ? el("span", { style: { marginLeft: "auto" } }, norm) : null), g1.div)),
    el("div", { class: "s-6" }, App.cartao("Tempo médio por tipo", "minutos (hh:mm)", leg(), el("div", { style: { height: "8px" } }), g2.div))));
  const plot1 = () => {
    if (g1.chart) { App.graficos = App.graficos.filter((x) => x !== g1.chart); g1.chart.destroy(); }
    const div = (L) => (norm && norm.value === "evento" ? (L.n || 1) : 1);
    g1.chart = G.barrasAgrupadas(g1.canvas, tipos, [
      { rotulo: A.rotulo, cor: A.cor, valores: tipos.map((t) => cont(A, t) / div(A)) },
      { rotulo: B.rotulo, cor: B.cor, valores: tipos.map((t) => cont(B, t) / div(B)) },
    ], { horizontal: true, fmt: (v) => App.fmt.num(v) });
  };
  if (norm) norm.onchange = plot1;
  plot1();
  G.barrasAgrupadas(g2.canvas, tipos, [
    { rotulo: A.rotulo, cor: A.cor, valores: tipos.map((t) => med(A, t)) },
    { rotulo: B.rotulo, cor: B.cor, valores: tipos.map((t) => med(B, t)) },
  ], { horizontal: true, fmt: (v) => App.fmt.min(v) });

  // volume por horário
  const hora = (c) => (c.hora_inicio ? +c.hora_inicio.slice(0, 2) : null);
  const contH = (L, h) => L.chamados.filter((c) => hora(c) === h).length / (porEvento ? (L.n || 1) : 1);
  const hs = Array.from({ length: 24 }, (_, h) => h).filter((h) => contH(A, h) || contH(B, h));
  const ini = hs.length ? Math.min(...hs) : 0, fim = hs.length ? Math.max(...hs) : 23;
  const faixa = Array.from({ length: fim - ini + 1 }, (_, i) => ini + i);
  const g3 = G.area("grafico grafico--baixo");
  const tabInd = App.tabela([
    { rotulo: "Indicador", render: (r) => el("b", {}, r[0]) },
    { rotulo: "A", num: true, render: (r) => r[1] },
    { rotulo: "B", num: true, render: (r) => r[2] },
    { rotulo: "Diferença", num: true, render: (r) => r[3] ?? "" },
  ], [
    ["Chamados", App.fmt.num(sA.n), App.fmt.num(sB.n), cor(sB.n - sA.n, fmtDeltaN)],
    ...(porEvento ? [["Chamados por evento", App.fmt.num(sA.porEv), App.fmt.num(sB.porEv), cor(pct(sA.porEv, sB.porEv), fmtPct)]] : []),
    ["Tempo médio", App.fmt.min(sA.media), App.fmt.min(sB.media), sA.media !== null && sB.media !== null ? cor(sB.media - sA.media, (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + App.fmt.min(Math.abs(v))) : ""],
    ["Tempo máximo", App.fmt.min(sA.max), App.fmt.min(sB.max), ""],
    ["Dentro do SLA", App.fmt.pct(sA.sla), App.fmt.pct(sB.sla), sA.sla !== null && sB.sla !== null ? cor(sA.sla - sB.sla, (v) => (v > 0 ? "−" : v < 0 ? "+" : "") + App.fmt.pct(Math.abs(v)).replace("%", " p.p.")) : ""],
    ...extras.map((x) => [x[0], x[1], x[2], ""]),
  ]);
  alvo.append(el("div", { class: "grade g-12", style: { marginTop: "16px" } },
    el("div", { class: "s-7" }, App.cartao("Volume de chamados por horário", porEvento ? "média por evento em cada hora" : "chamados abertos em cada hora",
      G.legenda([[A.rotulo, A.cor], [B.rotulo, B.cor]], true), el("div", { style: { height: "8px" } }), g3.div)),
    el("div", { class: "s-5" }, App.cartao("Indicadores de manutenção", "", tabInd))));
  G.linha(g3.canvas, faixa.map((h) => `${h}h`), [
    { rotulo: A.rotulo, cor: A.cor, valores: faixa.map((h) => contH(A, h)) },
    { rotulo: B.rotulo, cor: B.cor, valores: faixa.map((h) => contH(B, h)) },
  ], { fmt: (v) => App.fmt.num(v), rotulosValor: faixa.length <= 18, eixoY: { ticks: { color: App.cores.tinta3 } } });

  // listas (só faz sentido mostrar lado a lado quando são poucos)
  const colunas = [
    ...(porEvento ? [{ rotulo: "Evento", valor: (c) => c.evento, render: (c) => `${c.evento} · ${App.fmt.dataCurta(c.data)}` }] : []),
    { rotulo: "Início", valor: (c) => c.hora_inicio },
    { rotulo: "Tipo", valor: (c) => c.tipo },
    { rotulo: "Descrição", valor: (c) => c.descricao },
    { rotulo: "Tempo", num: true, valor: (c) => c.tempo, render: (c) => App.fmt.min(c.tempo) },
  ];
  alvo.append(el("div", { class: "grade g-12", style: { marginTop: "16px" } },
    el("div", { class: "s-6" }, App.cartao(`Chamados · ${A.rotulo}`, `${sA.n} registros`, App.tabela(colunas, A.chamados, { vazio: "Nenhum chamado." }))),
    el("div", { class: "s-6" }, App.cartao(`Chamados · ${B.rotulo}`, `${sB.n} registros`, App.tabela(colunas, B.chamados, { vazio: "Nenhum chamado." })))));
};

/* ---------------------------------------------------------------- MODO: DOIS PERÍODOS */
App.compararPeriodos = async function (raiz) {
  if (!App.avarias) App.avarias = await App.api("/api/itens?tipo=AVARIAS");
  if (!App.chamados) App.chamados = await App.api("/api/chamados");
  let est = { aDe: "", aAte: "", bDe: "", bAte: "", cats: [] };
  try { Object.assign(est, JSON.parse(localStorage.getItem("rge_periodos") || "{}")); } catch (e) { /* ok */ }
  const ano = new Date().getFullYear();
  if (!est.aDe && !est.bDe) est = { ...est, aDe: `${ano - 1}-01-01`, aAte: `${ano - 1}-12-31`, bDe: `${ano}-01-01`, bAte: `${ano}-12-31` };
  App.aplicarTema(App.filtroSoJogo(est.cats));
  const salvar = () => { try { localStorage.setItem("rge_periodos", JSON.stringify(est)); } catch (e) { /* ok */ } };

  const inp = (k) => { const i = el("input", { type: "date", value: est[k] }); i.onchange = () => { est[k] = i.value; salvar(); desenhar(); }; return i; };
  const iADe = inp("aDe"), iAAte = inp("aAte"), iBDe = inp("bDe"), iBAte = inp("bAte");
  const fixar = (a1, a2, b1, b2) => { Object.assign(est, { aDe: a1, aAte: a2, bDe: b1, bAte: b2 }); [iADe.value, iAAte.value, iBDe.value, iBAte.value] = [a1, a2, b1, b2]; salvar(); desenhar(); };
  const hoje = new Date();
  const mes = (d) => d.toISOString().slice(0, 7);
  const fimMes = (y, m) => new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);
  const y = hoje.getFullYear(), m = hoje.getMonth();
  const presets = [
    [`${ano - 1} × ${ano}`, () => fixar(`${ano - 1}-01-01`, `${ano - 1}-12-31`, `${ano}-01-01`, `${ano}-12-31`)],
    ["1º sem × 2º sem " + ano, () => fixar(`${ano}-01-01`, `${ano}-06-30`, `${ano}-07-01`, `${ano}-12-31`)],
    ["Mês passado × este mês", () => fixar(`${mes(new Date(Date.UTC(y, m - 1, 1)))}-01`, fimMes(y, m - 1), `${mes(new Date(Date.UTC(y, m, 1)))}-01`, fimMes(y, m))],
  ].map(([r, f]) => el("button", { class: "chip chip--mini", onclick: f }, r));
  const cats = [...App.meta.categorias];
  const chips = cats.map((c) => {
    const bt = el("button", { class: "chip", "aria-pressed": String(est.cats.includes(c)) }, el("i", { style: { background: App.corCategoria(c) } }), c);
    bt.onclick = () => {
      const i = est.cats.indexOf(c); i >= 0 ? est.cats.splice(i, 1) : est.cats.push(c); bt.setAttribute("aria-pressed", String(i < 0)); salvar();
      if (App.filtroSoJogo(est.cats) !== (App.tema === "verde")) App.rotear(); else desenhar();   // mudou o tema: redesenha a página toda
    };
    return bt;
  });
  const corpo = el("div");
  raiz.append(
    el("div", { class: "pagina-cabecalho" },
      el("div", {}, el("h2", {}, "Comparar"), el("p", {}, "Dois períodos lado a lado: avarias, chamados e custos"))),
    App.modoComparar("periodos"),
    el("div", { class: "filtros" },
      el("div", { class: "campo" }, el("span", {}, el("i", { class: "marcador", style: { background: App.cores.A } }), "Período A"), el("div", { class: "presets" }, iADe, iAAte)),
      el("div", { class: "campo" }, el("span", {}, el("i", { class: "marcador", style: { background: App.cores.B } }), "Período B"), el("div", { class: "presets" }, iBDe, iBAte)),
      el("div", { class: "campo" }, el("span", {}, "Atalhos"), el("div", { class: "presets" }, presets)),
      el("div", { class: "campo" }, el("span", {}, "Categoria (vazio = todas)"), el("div", { class: "chips" }, chips))),
    corpo);

  function desenhar() {
    App.destruirGraficos();
    App.limpar(corpo);
    const rotP = (de, ate) => `${de ? App.fmt.dataCurta(de) : "início"} a ${ate ? App.fmt.dataCurta(ate) : "hoje"}`;
    const lado = (de, ate, rotulo, cor) => {
      const evs = App.eventos.filter((e) => (!de || e.data >= de) && (!ate || e.data <= ate) && (!est.cats.length || est.cats.includes(e.categoria)) && (e.total > 0 || e.n_chamados > 0));
      const ids = new Set(evs.map((e) => e.id));
      return { rotulo, cor, n: evs.length, eventos: evs, avarias: App.avarias.filter((i) => ids.has(i.evento_id)), chamados: App.chamados.filter((c) => ids.has(c.evento_id)) };
    };
    const A = lado(est.aDe, est.aAte, `A: ${rotP(est.aDe, est.aAte)}`, App.cores.A);
    const B = lado(est.bDe, est.bAte, `B: ${rotP(est.bDe, est.bAte)}`, App.cores.B);
    if (!A.n && !B.n) { corpo.append(el("div", { class: "cartao vazio" }, "Nenhum evento nos dois períodos.")); return; }
    App.abasComparacao(corpo, {
      avarias: (alvo) => App.compararAvarias(alvo, A, B),
      chamados: (alvo) => App.compararChamados(alvo, A, B),
      custos: (alvo) => custosPeriodos(alvo, A, B),
    });
  }

  function custosPeriodos(alvo, A, B) {
    const { pct, fmtDelta, fmtPct, cor } = _cmp;
    const comps = [["Energia", "eletrica"], ["Água", "agua"], ["Gás", "gas"], ["Poço", "poco"], ["Irrigação (já na água)", "irrigacao"], ["MDO", "mdo"], ["Avarias", "avarias"], ["Insumos", "insumos"]].filter(([, k]) => [A, B].some((L) => L.eventos.some((e) => e[k])));
    const soma = (L, k) => App.soma(L.eventos, (e) => e[k]);
    const media = (L, k) => (L.n ? soma(L, k) / L.n : 0);
    const tA = soma(A, "total"), tB = soma(B, "total");
    alvo.append(el("div", { class: "kpis" },
      App.kpi(`Custo total · ${A.rotulo}`, App.fmt.brlCurto(tA), "core", `${A.n} eventos · média ${App.fmt.brlCurto(media(A, "total"))}`),
      App.kpi(`Custo total · ${B.rotulo}`, App.fmt.brlCurto(tB), "g900", `${B.n} eventos · média ${App.fmt.brlCurto(media(B, "total"))}`),
      App.kpi("Média por evento (B − A)", fmtDelta(media(B, "total") - media(A, "total")), media(B, "total") > media(A, "total") ? "p900" : "g200", fmtPct(pct(media(A, "total"), media(B, "total"))))));
    const usados = comps.filter(([, k]) => soma(A, k) || soma(B, k));
    const sel = el("select", {}, el("option", { value: "media" }, "Média por evento"), el("option", { value: "total" }, "Total do período"));
    const g = G.area("grafico");
    alvo.append(el("div", { class: "grade g-12" },
      el("div", { class: "s-6" }, App.cartao("Custo por componente", "A × B",
        el("div", { class: "linha-acoes", style: { marginTop: 0, marginBottom: "8px" } }, G.legenda([[A.rotulo, A.cor], [B.rotulo, B.cor]]), el("span", { style: { marginLeft: "auto" } }, sel)), g.div)),
      el("div", { class: "s-6" }, App.cartao("Diferenças por componente", "média por evento · positivo = B maior",
        App.tabela([
          { rotulo: "Componente", render: (c) => el("b", {}, c[0]) },
          { rotulo: "A", num: true, render: (c) => App.fmt.brl(media(A, c[1])) },
          { rotulo: "B", num: true, render: (c) => App.fmt.brl(media(B, c[1])) },
          { rotulo: "%", num: true, render: (c) => cor(pct(media(A, c[1]), media(B, c[1])), fmtPct) },
        ], usados)))));
    const plot = () => {
      if (g.chart) { App.graficos = App.graficos.filter((x) => x !== g.chart); g.chart.destroy(); }
      const f = sel.value === "media" ? media : soma;
      g.chart = G.barrasAgrupadas(g.canvas, usados.map((c) => c[0]), [
        { rotulo: A.rotulo, cor: A.cor, valores: usados.map((c) => f(A, c[1])) },
        { rotulo: B.rotulo, cor: B.cor, valores: usados.map((c) => f(B, c[1])) },
      ]);
    };
    sel.onchange = plot;
    plot();
  }

  desenhar();
};
