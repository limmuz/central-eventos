/* Página: Manutenção (chamados do CCO: eficiência, SLA, tipos, horários). */
"use strict";

App.paginas.manutencao = async function (raiz, params) {
  if (!App.chamados) App.chamados = await App.api("/api/chamados");
  let eventoId = params[0] ? +params[0] : null;
  App.aplicarTema(eventoId ? App.ehJogo(App.eventos.find((e) => e.id === eventoId)) : App.filtroSoJogo());

  const seletor = App.seletorEvento({
    valor: App.eventos.find((e) => e.id === eventoId),
    placeholder: "Todos os eventos do filtro",
    lista: App.eventos.filter((e) => e.n_chamados > 0),
    onSelect: (e) => { location.hash = e ? `#/manutencao/${e.id}` : "#/manutencao"; },
  });
  const limparEv = el("button", { class: "btn btn--linha btn--mini", hidden: !eventoId }, "Ver todos");
  limparEv.onclick = () => (location.hash = "#/manutencao");
  const corpo = el("div");
  raiz.append(
    el("div", { class: "pagina-cabecalho" },
      el("div", {}, el("h2", {}, "Manutenção"), el("p", {}, `Chamados do CCO · SLA de atendimento: até ${App.meta.sla_minutos} min`)),
      el("div", { class: "acoes" })),
    App.filtrosComEvento(eventoId, seletor, limparEv, () => App.barraFiltros((reset) => (reset ? App.rotear() : desenhar()), { placeholder: "Buscar evento ou descrição do chamado…" })),
    corpo);

  function desenhar() {
    App.destruirGraficos();
    App.limpar(corpo);
    const evFoco = eventoId ? App.eventos.find((e) => e.id === eventoId) : null;
    if (evFoco) corpo.append(App.cabecalhoEvento(evFoco, { rota: "manutencao" }));
    let chs;
    if (eventoId) chs = App.chamados.filter((c) => c.evento_id === eventoId);
    else {
      const ids = new Set(App.filtrarEventos(App.eventos, { ...App.filtros, busca: "" }).map((e) => e.id));
      const q = App.norm(App.filtros.busca);
      chs = App.chamados.filter((c) => ids.has(c.evento_id) && (!q || App.norm(`${c.evento} ${c.descricao} ${c.tipo}`).includes(q)));
    }
    if (!chs.length) { corpo.append(el("div", { class: "cartao vazio" }, "Nenhum chamado para os filtros escolhidos.")); return; }

    const comTempo = chs.filter((c) => c.tempo !== null);
    const media = App.media(comTempo, (c) => c.tempo);
    const dentro = comTempo.filter((c) => c.tempo <= App.meta.sla_minutos).length;
    const maior = comTempo.reduce((m, c) => (c.tempo > (m?.tempo ?? -1) ? c : m), null);
    const nEv = new Set(chs.map((c) => c.evento_id)).size;

    corpo.append(el("div", { class: "kpis" },
      App.kpi("Eficiência", App.fmt.min(media) + " min", "core", "tempo médio para execução"),
      App.kpi("Atendimento", App.fmt.pct(comTempo.length ? 100 * dentro / comTempo.length : null), "g200", "dos chamados dentro do SLA"),
      App.kpi("Tempo máximo", App.fmt.min(maior?.tempo), "p900", maior ? `${maior.tipo} · ${maior.evento}` : ""),
      App.kpi("Chamados", App.fmt.num(chs.length), "p100", `${nEv} evento(s) · ${App.fmt.num(chs.length / nEv)} por evento`)));

    /* ---- tempo médio por tipo  |  quantidade por tipo (blocos) */
    const porTipo = Object.entries(App.agrupar(chs, (c) => c.tipo || "SEM TIPO"))
      .map(([t, l]) => ({ t, n: l.length, media: App.media(l.filter((c) => c.tempo !== null), (c) => c.tempo), fora: l.filter((c) => c.tempo > App.meta.sla_minutos).length }))
      .sort((a, b) => b.n - a.n);
    const porMedia = [...porTipo].sort((a, b) => b.media - a.media);
    const a1 = G.area("grafico");
    a1.div.style.height = Math.max(240, porMedia.length * 40 + 30) + "px";
    const rampa = App.cores.rampa;
    const blocos = el("div", { class: "blocos-tipo" }, porTipo.map((x, i) => {
      const fundo = rampa[Math.min(i, rampa.length - 1)];
      const claro = i >= 4;
      return el("div", {
        style: { flex: String(Math.max(x.n, chs.length * 0.04)), background: fundo, color: claro ? App.cores.tinta : "#fff" },
        title: `${x.t}: ${x.n} chamados`,
      }, el("span", {}, x.t), el("b", {}, `${x.n} · ${App.fmt.pct(100 * x.n / chs.length)}`));
    }));
    corpo.append(el("div", { class: "grade g-12" },
      el("div", { class: "s-7" }, App.cartao("Média de tempo por tipo de chamado", "minutos (hh:mm)", a1.div)),
      el("div", { class: "s-5" }, App.cartao("Quantidade de chamados por tipo", "", blocos))));
    G.barrasH(a1.canvas, porMedia.map((x) => x.t), porMedia.map((x) => x.media),
      porMedia.map((x) => (x.media > App.meta.sla_minutos ? App.cores.destaque : App.cores.core)),
      { fmt: (v) => App.fmt.min(v), tooltipExtra: (i) => ` ${porMedia[i].n} chamados · ${porMedia[i].fora} fora do SLA` });

    /* ---- volume por horário */
    const horas = Array.from({ length: 24 }, (_, h) => h);
    const cont = horas.map((h) => chs.filter((c) => c.hora_inicio && +c.hora_inicio.slice(0, 2) === h).length);
    let ini = cont.findIndex((v) => v > 0), fim = 23 - [...cont].reverse().findIndex((v) => v > 0);
    if (ini < 0) { ini = 0; fim = 23; }
    const faixa = horas.slice(ini, fim + 1);
    const a2 = G.area("grafico grafico--baixo");
    corpo.append(el("div", { class: "grade", style: { marginTop: "16px" } },
      App.cartao("Volume de chamados por horário", "chamados abertos em cada hora", a2.div)));
    G.linha(a2.canvas, faixa.map((h) => `${h}h`), [{ rotulo: "chamados", cor: App.cores.core, valores: faixa.map((h) => cont[h]), area: true }],
      { fmt: (v) => App.fmt.num(v), rotulosValor: true, eixoY: { ticks: { precision: 0, color: App.cores.tinta3 } } });

    /* ---- por evento (quando não há evento específico) */
    if (!eventoId) {
      const porEv = Object.values(App.agrupar(chs, (c) => c.evento_id)).map((l) => ({
        id: l[0].evento_id, nome: l[0].evento, data: l[0].data, n: l.length,
        media: App.media(l.filter((c) => c.tempo !== null), (c) => c.tempo),
      })).sort((a, b) => b.n - a.n).slice(0, 25);
      const a3 = G.area("grafico");
      a3.div.style.height = Math.max(260, porEv.length * 32 + 30) + "px";
      corpo.append(el("div", { class: "grade", style: { marginTop: "16px" } },
        App.cartao("Eventos com mais chamados", "top 25 · clique para ver só o evento", a3.div)));
      G.barrasH(a3.canvas, porEv.map((x) => `${x.nome} · ${App.fmt.dataCurta(x.data)}`), porEv.map((x) => x.n), App.cores.core,
        { fmt: (v) => App.fmt.num(v), onClick: (i) => (location.hash = `#/manutencao/${porEv[i].id}`), tooltipExtra: (i) => ` tempo médio ${App.fmt.min(porEv[i].media)}` });
    }

    /* ---- tabela */
    corpo.append(el("div", { class: "grade", style: { marginTop: "16px" } },
      App.cartao("Chamados", `${chs.length} registros`,
        App.tabela([
          { rotulo: "Evento", valor: (c) => c.evento, render: (c) => el("a", { href: `#/evento/${c.evento_id}` }, c.evento) },
          { rotulo: "Data", valor: (c) => c.data, render: (c) => App.fmt.data(c.data) },
          { rotulo: "Descrição", valor: (c) => c.descricao },
          { rotulo: "Tipo", valor: (c) => c.tipo },
          { rotulo: "Início", valor: (c) => c.hora_inicio },
          { rotulo: "Fim", valor: (c) => c.hora_final },
          { rotulo: "Tempo", num: true, valor: (c) => c.tempo, render: (c) => App.fmt.min(c.tempo) },
          { rotulo: "SLA", valor: (c) => c.sla, render: (c) => c.sla ? el("span", { class: "etiqueta " + (c.sla.startsWith("DENTRO") ? "etiqueta--ok" : "etiqueta--alerta") }, c.sla.startsWith("DENTRO") ? "Dentro" : "Fora") : "—" },
        ], chs, { ordem: { i: 1, dir: -1 } }))));
  }
  desenhar();
};
