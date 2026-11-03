/* Página: Avarias (por item e por evento, com listas que expandem). */
"use strict";

App.paginas.avarias = async function (raiz, params = []) {
  if (!App.avarias) App.avarias = await App.api("/api/itens?tipo=AVARIAS");
  let eventoId = params[0] ? +params[0] : null;
  const evFoco = eventoId ? App.eventos.find((e) => e.id === eventoId) : null;
  if (!evFoco) eventoId = null;
  App.aplicarTema(evFoco ? App.ehJogo(evFoco) : App.filtroSoJogo());
  const comAvaria = new Set(App.avarias.map((i) => i.evento_id));
  const seletor = App.seletorEvento({
    valor: evFoco,
    placeholder: "Todos os eventos do filtro",
    lista: App.eventos.filter((e) => comAvaria.has(e.id)),
    onSelect: (e) => { location.hash = e ? `#/avarias/${e.id}` : "#/avarias"; },
  });
  const limparEv = el("button", { class: "btn btn--linha btn--mini", hidden: !eventoId }, "Ver todos");
  limparEv.onclick = () => (location.hash = "#/avarias");
  const corpo = el("div");
  raiz.append(
    el("div", { class: "pagina-cabecalho" },
      el("div", {}, el("h2", {}, "Avarias"), el("p", {}, "Itens avariados por evento: quantidade e valor")),
      el("div", { class: "acoes" }, App.importacao.botoesRelatorio())),
    App.filtrosComEvento(eventoId, seletor, limparEv, () => App.barraFiltros((reset) => (reset ? App.rotear() : desenhar()), { placeholder: "Buscar item avariado ou evento…" })),
    corpo);

  function desenhar() {
    App.destruirGraficos();
    App.limpar(corpo);
    if (evFoco) corpo.append(App.cabecalhoEvento(evFoco, { rota: "avarias" }));
    let av;
    if (eventoId) av = App.avarias.filter((i) => i.evento_id === eventoId);
    else {
      const ids = new Set(App.filtrarEventos(App.eventos, { ...App.filtros, busca: "" }).map((e) => e.id));
      const q = App.norm(App.filtros.busca);
      av = App.avarias.filter((i) => ids.has(i.evento_id) && (!q || App.norm(`${i.item} ${i.evento} ${App.fmt.data(i.data)}`).includes(q)));
    }
    if (!av.length) { corpo.append(el("div", { class: "cartao vazio" }, eventoId ? "Este evento não tem avarias lançadas." : "Nenhuma avaria para os filtros escolhidos.")); return; }

    const total = App.soma(av, (i) => i.total);
    const qtd = App.soma(av, (i) => i.qtd);
    const porItem = Object.entries(App.agrupar(av, (i) => i.item)).map(([item, l]) => ({
      chave: item, item, linhas: l, qtd: App.soma(l, (i) => i.qtd), total: App.soma(l, (i) => i.total),
      eventos: new Set(l.map((i) => i.evento_id)).size,
    }));
    const porEvento = Object.values(App.agrupar(av, (i) => i.evento_id)).map((l) => ({
      chave: l[0].evento_id, id: l[0].evento_id, evento: l[0].evento, data: l[0].data, categoria: l[0].categoria,
      linhas: l, qtd: App.soma(l, (i) => i.qtd), total: App.soma(l, (i) => i.total), n: new Set(l.map((i) => i.item)).size,
    }));
    const topItem = [...porItem].sort((a, b) => b.total - a.total)[0];
    const topEv = [...porEvento].sort((a, b) => b.total - a.total)[0];

    if (eventoId) return desenharEvento(av, porItem, total, qtd, topItem);

    /* ---- KPIs */
    corpo.append(el("div", { class: "kpis" },
      App.kpi("Valor total de avarias", App.fmt.brl(total), "core", `${porEvento.length} eventos com avaria`),
      App.kpi("Itens avariados", App.fmt.num(qtd), "p900", `${porItem.length} tipos de item`),
      App.kpi("Média por evento", App.fmt.brlCurto(total / porEvento.length), "p100", "entre eventos com avaria"),
      App.kpi("Item de maior custo", App.fmt.brlCurto(topItem.total), "g200", topItem.item),
      App.kpi("Evento de maior custo", App.fmt.brlCurto(topEv.total), "p100", `${topEv.evento} · ${App.fmt.dataCurta(topEv.data)}`)));

    /* ---- gráficos */
    const N = 15;
    const itensTop = [...porItem].sort((a, b) => b.total - a.total).slice(0, N);
    const evTop = [...porEvento].sort((a, b) => b.total - a.total).slice(0, N);
    const g1 = G.area("grafico");
    g1.div.style.height = (App.soma(itensTop, (x) => { const q = quebrar(x.item, 26); return Array.isArray(q) ? 16 + q.length * 20 : 38; }) + 50) + "px";
    const g2 = G.area("grafico"); g2.div.style.height = (evTop.length * 36 + 50) + "px";
    const cats = Object.entries(App.agrupar(evTop, (e) => e.categoria || ""));
    corpo.append(el("div", { class: "secao" }, el("h3", {}, "Gráficos")),
      el("div", { class: "grade g-12" },
        el("div", { class: "s-6" }, App.cartao(`Top ${itensTop.length} itens por valor`, "valor total de avarias por item", g1.div)),
        el("div", { class: "s-6" }, App.cartao(`Top ${evTop.length} eventos por valor de avarias`, "clique para abrir o evento",
          G.legenda(cats.map(([c]) => [c || "Sem categoria", App.corCategoria(c)])), el("div", { style: { height: "8px" } }), g2.div))));
    G.barrasH(g1.canvas, itensTop.map((x) => quebrar(x.item, 26)), itensTop.map((x) => x.total), App.cores.core,
      { tooltipExtra: (i) => ` ${App.fmt.num(itensTop[i].qtd)} un. · ${itensTop[i].eventos} evento(s)` });
    G.barrasH(g2.canvas, evTop.map((x) => `${x.evento} · ${App.fmt.dataCurta(x.data)}`), evTop.map((x) => x.total),
      evTop.map((x) => App.corCategoria(x.categoria)),
      { onClick: (i) => (location.hash = `#/evento/${evTop[i].id}`), tooltipExtra: (i) => ` ${App.fmt.num(evTop[i].qtd)} itens avariados` });

    const porMes = App.agrupar(av, (i) => i.data.slice(0, 7));
    const meses = Object.keys(porMes).sort();
    const nomeMes = (m) => { const [a, mm] = m.split("-"); return ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"][+mm - 1] + "/" + a.slice(2); };
    const g3 = G.area("grafico");
    const porCat = Object.entries(App.agrupar(av, (i) => i.categoria || "")).map(([c, l]) => ({ c, total: App.soma(l, (i) => i.total), qtd: App.soma(l, (i) => i.qtd), n: new Set(l.map((i) => i.evento_id)).size }))
      .sort((a, b) => b.total - a.total);
    const g4 = G.area("grafico"); g4.div.style.height = Math.max(200, porCat.length * 56 + 40) + "px";
    corpo.append(el("div", { class: "grade g-12", style: { marginTop: "16px" } },
      el("div", { class: "s-7" }, App.cartao("Avarias por mês", "valor total", g3.div)),
      el("div", { class: "s-5" }, App.cartao("Avarias por categoria", "valor total · média por evento no detalhe", g4.div))));
    G.novo(g3.canvas, {
      type: "bar",
      data: { labels: meses.map(nomeMes), datasets: [{ data: meses.map((m) => App.soma(porMes[m], (i) => i.total)), backgroundColor: App.cores.core, borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: false, maxBarThickness: 36,
        datalabels: { display: meses.length <= 16, anchor: "end", align: "end", offset: 2, color: App.cores.tinta, font: { weight: "600", size: 16 }, formatter: (v) => App.fmt.brlCurto(v).replace("R$ ", "") } }] },
      options: { layout: { padding: { top: 22 } }, scales: { x: G.eixoCategoria({ ticks: { maxRotation: 45, minRotation: meses.length > 12 ? 45 : 0 } }), y: G.eixoValor() },
        plugins: { tooltip: { callbacks: { label: (ctx) => " " + App.fmt.brl(ctx.raw) } } } },
    });
    G.barrasH(g4.canvas, porCat.map((x) => x.c || "Sem categoria"), porCat.map((x) => x.total), porCat.map((x) => App.corCategoria(x.c)),
      { tooltipExtra: (i) => ` ${porCat[i].n} eventos · média ${App.fmt.brlCurto(porCat[i].total / porCat[i].n)}` });

    /* ---- por item (expande: evento / data / qtd / valor) */
    corpo.append(el("div", { class: "secao" }, el("h3", {}, "Listas")),
      el("div", { class: "grade g-12" },
        el("div", { class: "s-6" }, App.cartao("Por item avariado", `${porItem.length} itens · clique para ver os eventos`,
          App.tabelaExpansivel([
            { rotulo: "Item", valor: (g) => g.item, render: (g) => el("b", {}, g.item) },
            { rotulo: "Eventos", num: true, valor: (g) => g.eventos },
            { rotulo: "Qtd.", num: true, valor: (g) => g.qtd, render: (g) => App.fmt.num(g.qtd), total: (l) => App.fmt.num(App.soma(l, (g) => g.qtd)) },
            { rotulo: "Valor total", num: true, valor: (g) => g.total, render: (g) => App.fmt.brl(g.total), total: (l) => App.fmt.brl(App.soma(l, (g) => g.total)) },
          ], porItem, {
            ordem: { i: 3, dir: -1 },
            filhos: (g) => g.linhas,
            colunasFilhos: [
              { rotulo: "Evento", valor: (i) => i.evento, render: (i) => el("a", { href: `#/evento/${i.evento_id}` }, i.evento) },
              { rotulo: "Data", valor: (i) => i.data, render: (i) => App.fmt.data(i.data) },
              { rotulo: "Qtd.", num: true, valor: (i) => i.qtd, render: (i) => App.fmt.num(i.qtd), total: (l) => App.fmt.num(App.soma(l, (i) => i.qtd)) },
              { rotulo: "Valor", num: true, valor: (i) => i.total, render: (i) => App.fmt.brl(i.total), total: (l) => App.fmt.brl(App.soma(l, (i) => i.total)) },
            ],
          }))),
        /* ---- por evento (expande: item / qtd / valor) */
        el("div", { class: "s-6" }, App.cartao("Por evento", `${porEvento.length} eventos · clique para ver as avarias`,
          App.tabelaExpansivel([
            { rotulo: "Evento", valor: (g) => g.evento, render: (g) => el("b", {}, g.evento) },
            { rotulo: "Data", valor: (g) => g.data, render: (g) => App.fmt.data(g.data) },
            { rotulo: "Qtd.", num: true, valor: (g) => g.qtd, render: (g) => App.fmt.num(g.qtd), total: (l) => App.fmt.num(App.soma(l, (g) => g.qtd)) },
            { rotulo: "Valor total", num: true, valor: (g) => g.total, render: (g) => App.fmt.brl(g.total), total: (l) => App.fmt.brl(App.soma(l, (g) => g.total)) },
          ], porEvento, {
            ordem: { i: 1, dir: -1 },
            filhos: (g) => g.linhas,
            colunasFilhos: [
              { rotulo: "Item", valor: (i) => i.item },
              { rotulo: "Valor unit.", num: true, valor: (i) => i.valor_unit, render: (i) => App.fmt.brl(i.valor_unit) },
              { rotulo: "Qtd.", num: true, valor: (i) => i.qtd, render: (i) => App.fmt.num(i.qtd), total: (l) => App.fmt.num(App.soma(l, (i) => i.qtd)) },
              { rotulo: "Valor", num: true, valor: (i) => i.total, render: (i) => App.fmt.brl(i.total), total: (l) => App.fmt.brl(App.soma(l, (i) => i.total)) },
            ],
          })))));
  }

  /** Um evento só: KPIs, gráfico dos itens e a lista completa. */
  function desenharEvento(av, porItem, total, qtd, topItem) {
    const maisQtd = [...porItem].sort((a, b) => b.qtd - a.qtd)[0];
    corpo.append(el("div", { class: "kpis" },
      App.kpi("Valor total de avarias", App.fmt.brl(total), "core", `${av.length} lançamento(s)`),
      App.kpi("Itens avariados", App.fmt.num(qtd), "p900", `${porItem.length} tipos de item`),
      App.kpi("Item de maior custo", App.fmt.brlCurto(topItem.total), "g200", topItem.item),
      App.kpi("Item mais avariado", App.fmt.num(maisQtd.qtd) + " un.", "p100", maisQtd.item)));
    const itens = [...porItem].sort((a, b) => b.total - a.total);
    const g1 = G.area("grafico");
    g1.div.style.height = (App.soma(itens, (x) => { const q = quebrar(x.item, 38); return Array.isArray(q) ? 16 + q.length * 20 : 38; }) + 50) + "px";
    corpo.append(el("div", { class: "grade g-12" },
      el("div", { class: "s-6" }, App.cartao("Avarias por item", "valor total de cada item neste evento", g1.div)),
      el("div", { class: "s-6" }, App.cartao("Lista de avarias", `${av.length} lançamento(s)`,
        App.tabela([
          { rotulo: "Item", valor: (i) => i.item, render: (i) => el("b", {}, i.item) },
          { rotulo: "Valor unit.", num: true, valor: (i) => i.valor_unit, render: (i) => App.fmt.brl(i.valor_unit) },
          { rotulo: "Qtd.", num: true, valor: (i) => i.qtd, render: (i) => App.fmt.num(i.qtd), total: (l) => App.fmt.num(App.soma(l, (i) => i.qtd)) },
          { rotulo: "Valor", num: true, valor: (i) => i.total, render: (i) => App.fmt.brl(i.total), total: (l) => App.fmt.brl(App.soma(l, (i) => i.total)) },
        ], av, { rodape: true, ordem: { i: 3, dir: -1 } })))));
    G.barrasH(g1.canvas, itens.map((x) => quebrar(x.item, 38)), itens.map((x) => x.total), App.cores.core,
      { tooltipExtra: (i) => ` ${App.fmt.num(itens[i].qtd)} un.` });
  }

  /** quebra rótulos longos em várias linhas (o Chart.js aceita array de linhas) */
  function quebrar(t, max) {
    const palavras = t.split(" "), linhas = [""];
    for (const p of palavras) {
      if ((linhas[linhas.length - 1] + " " + p).trim().length > max) linhas.push(p);
      else linhas[linhas.length - 1] = (linhas[linhas.length - 1] + " " + p).trim();
    }
    return linhas.length > 1 ? linhas : linhas[0];
  }

  desenhar();
};
