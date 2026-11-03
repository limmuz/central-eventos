/* Página: Visão geral (custo total, por evento, por gênero, por categoria, mês, avarias). */
"use strict";

App.paginas.visao = async function (raiz) {
  const corpo = el("div");
  raiz.append(
    el("div", { class: "pagina-cabecalho" },
      el("div", {}, el("h2", {}, "Visão geral"), el("p", {}, "Custos de MDO, avarias, insumos e medidores de consumo por evento"))),
    App.barraFiltros((reset) => (reset ? App.rotear() : desenhar()), { componentes: true }),
    corpo);

  function desenhar() {
    App.destruirGraficos();
    App.limpar(corpo);
    const base = App.filtrarEventos();
    const temIns = base.some((e) => e.insumos > 0);
    // componentes escolhidos no filtro (nenhum = todos); insumos só entram se existirem
    const comps = App.compsAtivos().filter(([k]) => k !== "INSUMOS" || temIns);
    const filtrado = App.filtros.componentes.length > 0;
    const nomesComps = comps.map(([k]) => App.NOMES_COMP[k]);
    const listaNomes = (n) => (n.length > 1 ? n.slice(0, -1).join(", ") + " e " + n[n.length - 1] : n[0] || "");
    // "tot" = soma só dos componentes escolhidos
    const evs = base.map((e) => ({ ...e, tot: App.totalComps(e, comps) })).filter((e) => e.tot > 0);
    if (!evs.length || !comps.length) { corpo.append(el("div", { class: "cartao vazio" }, "Nenhum evento com custo para os filtros escolhidos.")); return; }
    const C = App.cores.componente;
    const tot = App.soma(evs, (e) => e.tot);
    const somaDe = (campo) => App.soma(evs, (e) => e[campo]);
    const KPI_COMP = { RELOGIOS: ["Medidores de consumo", "g200"], MDO: ["Mão de obra (MDO)", "p100"], AVARIAS: ["Avarias", "p100"], INSUMOS: ["Insumos", "p100"] };
    const ordemKpi = ["RELOGIOS", "MDO", "AVARIAS", "INSUMOS"].filter((k) => comps.some(([c]) => c === k));

    corpo.append(el("div", { class: "kpis" },
      App.kpi(filtrado ? `Custo · ${listaNomes(nomesComps)}` : "Custo total", App.fmt.brlCurto(tot), "core", `${evs.length} eventos no período`),
      App.kpi("Média por evento", App.fmt.brlCurto(tot / evs.length), "p900"),
      comps.length > 1 ? ordemKpi.map((k) => {
        const v = somaDe(App.COMPONENTES.find(([c]) => c === k)[1]);
        return App.kpi(KPI_COMP[k][0], App.fmt.brlCurto(v), KPI_COMP[k][1], App.fmt.pct(100 * v / tot) + (filtrado ? " do selecionado" : " do total"));
      }) : null,
    ));

    /* ---- cards dos medidores: valor (R$) + quantidade consumida (m³ / kWh) */
    if (comps.some(([k]) => k === "RELOGIOS")) {
      // a irrigação do gramado (jogos, a partir de out/2026) já está dentro da água: o card só mostra quanto dela é irrigação
      const med = [["Água", "agua", "m³", "p100"], ["Energia elétrica", "eletrica", "kWh", "p100"], ["Gás", "gas", "m³", "p100"], ["Poço artesiano", "poco", "m³", "g200"]];
      const irrV = App.soma(evs, (e) => e.irrigacao || 0), irrQ = App.soma(evs, (e) => e.irrigacao_consumo || 0);
      const valorDe = (e, campo) => e[campo] || 0;
      const qtdDe = (e, campo) => e[campo + "_consumo"] || 0;
      corpo.append(el("div", { class: "kpis" }, med.map(([rot, campo, un, est]) => {
        const comLeitura = evs.filter((e) => qtdDe(e, campo) > 0);
        const q = App.soma(comLeitura, (e) => qtdDe(e, campo));
        return App.kpi(rot, App.fmt.brlCurto(App.soma(evs, (e) => valorDe(e, campo))), est,
          el("span", {}, el("span", { class: "kpi__consumo" }, `${App.fmt.num(q)} ${un}`, el("small", {}, " consumidos")),
            el("br"), comLeitura.length ? `média ${App.fmt.num(q / comLeitura.length)} ${un} por evento` : "sem leitura",
            campo === "agua" && (irrV || irrQ) ? el("span", { class: "kpi__extra" }, el("br"), `dos quais irrigação do gramado ${App.fmt.brlCurto(irrV)} · ${App.fmt.num(irrQ)} m³`) : null));
      })));
    }

    /* ---- custo por evento (barras horizontais: nada fica cortado no print) */
    const ord = [...evs].sort((a, b) => b.tot - a.tot);
    const a1 = G.area("grafico");
    const qtdSel = el("select", {},
      [["15", "Top 15"], ["25", "Top 25"], ["50", "Top 50"], ["0", "Todos"]].map(([v2, r]) => el("option", { value: v2 }, r)));
    const ordemSel = el("select", {}, el("option", { value: "total" }, "Maior custo"), el("option", { value: "data" }, "Mais recentes"));
    const cartaoEv = App.cartao("Custo por evento", `${listaNomes(nomesComps)} · clique numa barra para abrir o evento`,
      el("div", { class: "linha-acoes", style: { marginTop: 0, marginBottom: "10px" } },
        G.legenda(comps.map(([k]) => [App.NOMES_COMP[k], C[k]])),
        el("span", { style: { marginLeft: "auto", display: "flex", gap: "8px" } }, qtdSel, ordemSel)),
      a1.div);
    corpo.append(el("div", { class: "secao" }, el("h3", {}, "Custos por evento")), el("div", { class: "grade" }, cartaoEv));
    const plotarEventos = () => {
      let lista = ordemSel.value === "data" ? [...evs].sort((a, b) => b.data.localeCompare(a.data)) : ord;
      const n = +qtdSel.value;
      if (n) lista = lista.slice(0, n);
      a1.div.style.height = (lista.length * 26 + 60) + "px";
      if (a1.chart) { App.graficos = App.graficos.filter((g) => g !== a1.chart); a1.chart.destroy(); }
      a1.chart = G.barrasHEmpilhadas(a1.canvas, lista.map((e) => `${e.nome} · ${App.fmt.dataCurta(e.data)}`),
        comps.map(([k, campo]) => ({ rotulo: App.NOMES_COMP[k], cor: C[k], valores: lista.map((e) => e[campo]) })),
        { onClick: (i) => (location.hash = `#/evento/${lista[i].id}`) });
      const tit = cartaoEv.querySelector(".cartao__titulo h3");
      tit.firstChild.textContent = n && evs.length > n ? `Custo por evento · top ${n}` : "Custo por evento";
    };
    qtdSel.onchange = plotarEventos;
    ordemSel.onchange = plotarEventos;
    plotarEventos();

    /* ---- média por gênero + média por categoria */
    const porGen = Object.entries(App.agrupar(evs, (e) => e.genero || "SEM GÊNERO"))
      .map(([g, l]) => ({ g, media: App.media(l, (e) => e.tot), n: l.length, cat: moda(l.map((e) => e.categoria)) }))
      .sort((a, b) => b.media - a.media);
    const a2 = G.area("grafico", null);
    a2.div.style.height = Math.max(260, porGen.length * 28 + 40) + "px";
    const cats = Object.entries(App.agrupar(evs, (e) => e.categoria || "")).sort((a, b) => b[1].length - a[1].length);
    const a3 = G.area("grafico");
    corpo.append(el("div", { class: "secao" }, el("h3", {}, "Médias")), el("div", { class: "grade g-12" },
      el("div", { class: "s-6" }, App.cartao("Média por gênero", "custo médio por evento · cor = categoria predominante",
        G.legenda(cats.map(([c]) => [c || "Sem categoria", App.corCategoria(c)])), el("div", { style: { height: "10px" } }), a2.div)),
      el("div", { class: "s-6" }, App.cartao("Média por categoria", "custo médio por evento, por componente",
        G.legenda(comps.map(([k]) => [App.NOMES_COMP[k], C[k]])), el("div", { style: { height: "10px" } }), a3.div,
        el("div", { class: "kpis", style: { marginTop: "14px", marginBottom: 0 } },
          cats.map(([c, l]) => App.kpi(c || "Sem categoria", App.fmt.brlCurto(App.media(l, (e) => e.tot)), "branco", `${l.length} eventos · média ${filtrado ? "do selecionado" : "total"}`, `Custo médio de um evento da categoria ${c || "sem categoria"}: soma do custo dos ${l.length} eventos ÷ ${l.length}, nos componentes escolhidos no filtro.`)))))));
    G.barrasH(a2.canvas, porGen.map((x) => x.g), porGen.map((x) => x.media), porGen.map((x) => App.corCategoria(x.cat)),
      { tooltipExtra: (i) => ` ${porGen[i].n} evento(s)` });
    G.barrasAgrupadas(a3.canvas, cats.map(([c]) => c || "Sem categoria"),
      comps.map(([k, campo]) => ({ rotulo: App.NOMES_COMP[k], cor: C[k], valores: cats.map(([, l]) => App.media(l, (e) => e[campo])) })));

    /* ---- evolução mensal + medidores por tipo */
    const porMes = App.agrupar(evs, (e) => e.data.slice(0, 7));
    const meses = Object.keys(porMes).sort();
    const a4 = G.area("grafico");
    const R = App.cores.relogio;
    const a5 = G.area("grafico");
    const comRelogios = comps.some(([k]) => k === "RELOGIOS");
    corpo.append(el("div", { class: "secao" }, el("h3", {}, comRelogios ? "Evolução e consumo" : "Evolução")), el("div", { class: "grade g-12" },
      el("div", { class: comRelogios ? "s-7" : "s-12" }, App.cartao("Custo por mês", "soma dos eventos de cada mês",
        G.legenda(comps.map(([k]) => [App.NOMES_COMP[k], C[k]])), el("div", { style: { height: "10px" } }), a4.div)),
      comRelogios ? el("div", { class: "s-5" }, App.cartao("Medidores de consumo", "média por evento, por categoria",
        G.legenda(Object.entries(R).filter(([k]) => k !== "IRRIGAÇÃO").map(([k, c]) => [k, c])), el("div", { style: { height: "10px" } }), a5.div)) : null));
    const nomeMes = (m) => { const [a, mm] = m.split("-"); return ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"][+mm - 1] + "/" + a.slice(2); };
    G.barrasEmpilhadas(a4.canvas, meses.map(nomeMes),
      comps.map(([k, campo]) => ({ rotulo: App.NOMES_COMP[k], cor: C[k], valores: meses.map((m) => App.soma(porMes[m], (e) => e[campo])) })),
      { rotacao: meses.length > 12 ? 45 : 0, totalNoTopo: meses.length <= 14 });
    const comRel = cats.map(([c, l]) => [c, l.filter((e) => e.n_relogios > 0)]);
    if (comRelogios) G.barrasAgrupadas(a5.canvas, comRel.map(([c]) => c || "Sem categoria"),
      [["ELÉTRICA", "eletrica"], ["ÁGUA", "agua"], ["GÁS", "gas"], ["POÇO", "poco"]].map(([k, campo]) => ({
        rotulo: k, cor: R[k], valores: comRel.map(([, l]) => App.media(l, (e) => e[campo])),
      })));

    /* ---- tabela de eventos */
    corpo.append(el("div", { class: "secao" }, el("h3", {}, "Tabela")), el("div", { class: "grade" },
      App.cartao("Eventos", `${evs.length} eventos · clique para abrir`,
        App.tabela([
          { rotulo: "Evento", valor: (e) => e.nome, render: (e) => el("b", {}, e.nome) },
          { rotulo: "Data", valor: (e) => e.data, render: (e) => App.fmt.data(e.data) },
          { rotulo: "Categoria", valor: (e) => e.categoria, render: (e) => el("span", { class: "etiqueta" }, el("i", { style: { background: App.corCategoria(e.categoria) } }), e.categoria || "—") },
          { rotulo: "Gênero", valor: (e) => e.genero },
          ...comps.map(([k, campo]) => ({ rotulo: App.NOMES_COMP[k], num: true, valor: (e) => e[campo], render: (e) => App.fmt.brl(e[campo]), total: (l) => App.fmt.brl(App.soma(l, (e) => e[campo])) })),
          ...(comps.length > 1 ? [{ rotulo: filtrado ? "Total selecionado" : "Total", num: true, valor: (e) => e.tot, render: (e) => el("b", {}, App.fmt.brl(e.tot)), total: (l) => App.fmt.brl(App.soma(l, (e) => e.tot)) }] : []),
          { rotulo: "Chamados", num: true, valor: (e) => e.n_chamados },
        ], evs, { onClick: (e) => (location.hash = `#/evento/${e.id}`), rodape: true, ordem: { i: 1, dir: -1 } }))));
  }

  function moda(arr) {
    const c = {};
    arr.forEach((x) => (c[x] = (c[x] || 0) + 1));
    return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  }

  desenhar();
};
