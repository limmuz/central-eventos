/* Gráficos (Chart.js) com o padrão visual do site. */
"use strict";

Chart.register(ChartDataLabels);
Chart.defaults.font.family = getComputedStyle(document.body).getPropertyValue("--fonte") || "Segoe UI, sans-serif";
Chart.defaults.font.size = 16;
Chart.defaults.color = App.cores.tinta2;
Chart.defaults.borderColor = App.cores.linha;
Chart.defaults.plugins.legend.display = false;
Chart.defaults.plugins.datalabels.display = false;
Chart.defaults.maintainAspectRatio = false;
Chart.defaults.animation.duration = 350;
Object.assign(Chart.defaults.plugins.tooltip, {
  backgroundColor: App.cores.tooltip || "#1E002F", titleColor: "#fff", bodyColor: App.cores.tooltipTexto || "#ECDFFF", padding: 10, cornerRadius: 8,
  boxWidth: 14, boxHeight: 3, usePointStyle: false, bodyFont: { size: 16 }, titleFont: { size: 16, weight: "600" },
});

App.graficos = [];
App.destruirGraficos = () => { App.graficos.forEach((g) => g.destroy()); App.graficos = []; };

const G = {};
App.G = G;

/** Cria um <canvas> dentro de um contêiner com altura definida pelo CSS. */
G.area = (classe = "grafico", largura = null) => {
  const c = el("canvas");
  const d = el("div", { class: classe, style: largura ? { width: largura + "px" } : null }, c);
  return { div: d, canvas: c };
};

G.novo = (canvas, cfg) => {
  const g = new Chart(canvas, cfg);
  App.graficos.push(g);
  return g;
};

const eixoValor = (extra = {}) => ({
  beginAtZero: true,
  grid: { color: App.cores.linha, drawTicks: false },
  border: { display: false },
  ticks: { callback: (v) => App.fmt.eixo(v), padding: 8, color: App.cores.tinta3 },
  ...extra,
});
const eixoCategoria = (extra = {}) => ({
  grid: { display: false },
  border: { color: App.cores.borda },
  ticks: { color: App.cores.tinta2, autoSkip: false, ...((extra.ticks) || {}) },
  ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "ticks")),
});
/** espaço à direita para o número escrito na ponta da barra não ser cortado (medido no tamanho real da fonte) */
const _medidor = document.createElement("canvas").getContext("2d");
const folgaDireita = (textos, minimo = 40) => {
  _medidor.font = `600 16px ${Chart.defaults.font.family}`;
  return Math.max(minimo, Math.ceil(Math.max(0, ...textos.map((t) => _medidor.measureText(String(t)).width))) + 18);
};
G.folgaDireita = folgaDireita;
G.eixoValor = eixoValor;
G.eixoCategoria = eixoCategoria;

/** Barras verticais empilhadas. series: [{rotulo, cor, valores}] ; totalNoTopo: rótulo com a soma. */
G.barrasEmpilhadas = (canvas, rotulos, series, { onClick = null, totalNoTopo = true, fmt = App.fmt.brlCurto, rotacao = 50, tamanhoRotulo = 16 } = {}) => {
  const n = series.length;
  return G.novo(canvas, {
    type: "bar",
    data: {
      labels: rotulos,
      datasets: series.map((s, i) => ({
        label: s.rotulo, data: s.valores, backgroundColor: s.cor, hoverBackgroundColor: s.cor,
        borderColor: "#fff", borderWidth: { top: i < n - 1 ? 2 : 0, left: 0, right: 0, bottom: 0 },
        borderSkipped: false, borderRadius: i === n - 1 ? { topLeft: 4, topRight: 4 } : 0,
        maxBarThickness: 46, categoryPercentage: .78, barPercentage: .92,
        datalabels: i === n - 1 && totalNoTopo ? {
          display: true, anchor: "end", align: "end", offset: 2, clamp: true,
          color: App.cores.tinta, font: { weight: "600", size: Math.max(16, tamanhoRotulo) },
          formatter: (_, ctx) => fmt(series.reduce((s2, ss) => s2 + (ss.valores[ctx.dataIndex] || 0), 0)).replace("R$ ", ""),
        } : { display: false },
      })),
    },
    options: {
      layout: { padding: { top: 22 } },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { stacked: true, ...eixoCategoria({ ticks: { maxRotation: rotacao, minRotation: rotacao > 0 ? rotacao : 0, font: { size: 16 } } }) },
        y: { stacked: true, ...eixoValor() },
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${(fmt === App.fmt.brlCurto ? App.fmt.brl : fmt)(ctx.raw)}  ${ctx.dataset.label}`,
            footer: (items) => "Total: " + (fmt === App.fmt.brlCurto ? App.fmt.brl : fmt)(items.reduce((s, i) => s + (i.raw || 0), 0)),
          },
        },
      },
      onClick: onClick ? (_, els) => els.length && onClick(els[0].index) : null,
      onHover: onClick ? (ev, els) => (ev.native.target.style.cursor = els.length ? "pointer" : "default") : null,
    },
  });
};

/** Barras horizontais com rótulo de valor na ponta. cores: string | array */
G.barrasH = (canvas, rotulos, valores, cores, { fmt = App.fmt.brlCurto, onClick = null, tooltipExtra = null, max = null, fmtEixo = null, linhaRef = null } = {}) =>
  G.novo(canvas, {
    type: "bar",
    data: {
      labels: rotulos,
      datasets: [{
        data: valores, backgroundColor: cores, hoverBackgroundColor: cores, borderRadius: { topRight: 4, bottomRight: 4 },
        borderSkipped: false, maxBarThickness: 22, categoryPercentage: .82, barPercentage: .9,
        datalabels: { display: true, anchor: "end", align: "end", offset: 4, color: App.cores.tinta, font: { weight: "600", size: 16 }, formatter: (v) => fmt(v) },
      }],
    },
    options: {
      indexAxis: "y",
      layout: { padding: { right: folgaDireita(valores.map((v) => fmt(v))), top: linhaRef ? 18 : 0 } },
      scales: {
        x: { ...eixoValor({ ticks: { callback: (v) => (fmtEixo || App.fmt.eixo)(v), color: App.cores.tinta3, maxTicksLimit: 5 } }), max: max || undefined },
        y: eixoCategoria({ ticks: { font: { size: 16, weight: "600" } } }),
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: (ctx) => " " + fmt(ctx.raw),
            afterLabel: tooltipExtra ? (ctx) => tooltipExtra(ctx.dataIndex) : undefined,
          },
        },
      },
      onClick: onClick ? (_, els) => els.length && onClick(els[0].index) : null,
      onHover: onClick ? (ev, els) => (ev.native.target.style.cursor = els.length ? "pointer" : "default") : null,
    },
    plugins: linhaRef ? [{   // linha de referência vertical (ex.: 100% do aprovado)
      id: "referencia",
      afterDatasetsDraw(ch) {
        const x = ch.scales.x.getPixelForValue(linhaRef.valor), { top, bottom } = ch.chartArea, ctx = ch.ctx;
        ctx.save(); ctx.strokeStyle = linhaRef.cor || "#B42318"; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = linhaRef.cor || "#B42318"; ctx.font = "600 16px sans-serif"; ctx.textAlign = "center";
        ctx.fillText(linhaRef.rotulo || "", x, top - 4); ctx.restore();
      },
    }] : [],
  });

/** Barras agrupadas (ex.: A x B por componente). */
G.barrasAgrupadas = (canvas, rotulos, series, { fmt = App.fmt.brlCurto, horizontal = false, rotulosValor = true } = {}) => {
  // muitas barras lado a lado: o número fica na vertical, em cima de cada barra, para um não encostar no outro
  const denso = !horizontal && series.length * rotulos.length > 9;
  return G.novo(canvas, {
    type: "bar",
    data: {
      labels: rotulos,
      datasets: series.map((s) => ({
        label: s.rotulo, data: s.valores, backgroundColor: s.cor, hoverBackgroundColor: s.cor,
        borderRadius: horizontal ? { topRight: 4, bottomRight: 4 } : { topLeft: 4, topRight: 4 },
        borderSkipped: false, maxBarThickness: 34, categoryPercentage: .72, barPercentage: .9,
        borderColor: "#fff", borderWidth: 0,
        datalabels: rotulosValor ? {
          display: (ctx) => (ctx.dataset.data[ctx.dataIndex] || 0) !== 0, anchor: "end", align: "end", offset: 2, color: App.cores.tinta,
          rotation: denso ? -90 : 0, clamp: true,
          font: { weight: "600", size: 16 }, formatter: (v) => fmt(v).replace("R$ ", ""),
        } : { display: false },
      })),
    },
    options: {
      indexAxis: horizontal ? "y" : "x",
      layout: { padding: horizontal ? { right: folgaDireita(series.flatMap((s) => s.valores.map((v) => fmt(v).replace("R$ ", "")))) } : { top: 24 } },
      interaction: { mode: "index", intersect: false },
      scales: horizontal
        ? { x: eixoValor({ ticks: { callback: (v) => App.fmt.eixo(v), color: App.cores.tinta3, maxTicksLimit: 5 } }), y: eixoCategoria({ ticks: { font: { weight: "600" } } }) }
        : { x: eixoCategoria({ ticks: { font: { weight: "600" } } }), y: eixoValor({ grace: denso ? "24%" : "8%" }) },
      plugins: { tooltip: { callbacks: { label: (ctx) => ` ${fmt(ctx.raw)}  ${ctx.dataset.label}` } } },
    },
  });
};

/** Linha / área. series: [{rotulo, cor, valores, area?}] */
G.linha = (canvas, rotulos, series, { fmt = (v) => App.fmt.num(v), rotulosValor = false, eixoY = {} } = {}) =>
  G.novo(canvas, {
    type: "line",
    data: {
      labels: rotulos,
      datasets: series.map((s) => ({
        label: s.rotulo, data: s.valores, borderColor: s.cor, backgroundColor: s.cor + "26",
        fill: !!s.area, tension: s.tracejado ? 0 : .3, cubicInterpolationMode: "monotone", borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, borderDash: s.tracejado ? [7, 5] : [],
        pointHoverBackgroundColor: s.cor, pointHoverBorderColor: "#fff", pointHoverBorderWidth: 2, spanGaps: true,
        datalabels: s.rotuloFim ? {   // nome e valor escritos no fim da linha (ex.: limite fixo do ano)
          display: (ctx) => ctx.dataIndex === Math.min(2, ctx.dataset.data.length - 1), align: "top", anchor: "center", offset: 2,
          color: s.cor, font: { weight: "700", size: 16 }, formatter: (v) => `${s.rotuloFim}: ${fmt(v)}`,
        } : rotulosValor ? {
          display: (ctx) => ctx.dataset.data[ctx.dataIndex] > 0, align: "top", offset: 4, clamp: true, color: App.cores.tinta, font: { weight: "700", size: 16 }, formatter: fmt,
        } : { display: false },
      })),
    },
    options: {
      layout: { padding: { top: rotulosValor ? 26 : 10, right: 12 } },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: eixoCategoria({ ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 14 } }),
        // folga acima do maior valor para o pico e o número dele não encostarem no topo
        y: eixoValor({ grace: rotulosValor ? "18%" : "8%", ticks: { callback: (v) => App.fmt.eixo(v), color: App.cores.tinta3 }, ...eixoY }),
      },
      plugins: { tooltip: { callbacks: { label: (ctx) => ` ${fmt(ctx.raw)}  ${ctx.dataset.label}` } } },
    },
    plugins: [{ // linha vertical seguindo o mouse
      id: "mira",
      afterDraw(ch) {
        const a = ch.tooltip && ch.tooltip.getActiveElements();
        if (!a || !a.length) return;
        const x = a[0].element.x, { top, bottom } = ch.chartArea, ctx = ch.ctx;
        ctx.save(); ctx.strokeStyle = App.cores.guia; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke(); ctx.restore();
      },
    }],
  });

G.legenda = (itens, linha = false) =>
  el("div", { class: "legenda" }, itens.map(([rot, cor]) => el("span", {}, el("i", { class: linha ? "linha" : "", style: { background: cor } }), rot)));

/** Barras horizontais empilhadas (cabe qualquer quantidade de eventos sem rolagem lateral). */
G.barrasHEmpilhadas = (canvas, rotulos, series, { onClick = null, fmt = App.fmt.brlCurto } = {}) => {
  const n = series.length;
  return G.novo(canvas, {
    type: "bar",
    data: {
      labels: rotulos,
      datasets: series.map((s, i) => ({
        label: s.rotulo, data: s.valores, backgroundColor: s.cor, hoverBackgroundColor: s.cor,
        borderColor: "#fff", borderWidth: { right: i < n - 1 ? 2 : 0, left: 0, top: 0, bottom: 0 }, borderSkipped: false,
        borderRadius: i === n - 1 ? { topRight: 4, bottomRight: 4 } : 0,
        maxBarThickness: 20, categoryPercentage: .8, barPercentage: .92,
        datalabels: i === n - 1 ? {
          display: true, anchor: "end", align: "end", offset: 4, color: App.cores.tinta, font: { weight: "600", size: 16 },
          formatter: (_, ctx) => fmt(series.reduce((s2, ss) => s2 + (ss.valores[ctx.dataIndex] || 0), 0)),
        } : { display: false },
      })),
    },
    options: {
      indexAxis: "y",
      layout: { padding: { right: folgaDireita(rotulos.map((_, i) => fmt(series.reduce((s2, ss) => s2 + (ss.valores[i] || 0), 0)))) } },
      interaction: { mode: "index", intersect: false, axis: "y" },
      scales: {
        x: { stacked: true, ...eixoValor({ ticks: { callback: (v) => App.fmt.eixo(v), color: App.cores.tinta3, maxTicksLimit: 6 } }) },
        y: { stacked: true, ...eixoCategoria({ ticks: { font: { size: 16 }, color: App.cores.tinta } }) },
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${(fmt === App.fmt.brlCurto ? App.fmt.brl : fmt)(ctx.raw)}  ${ctx.dataset.label}`,
            footer: (items) => "Total: " + (fmt === App.fmt.brlCurto ? App.fmt.brl : fmt)(items.reduce((s, i) => s + (i.raw || 0), 0)),
          },
        },
      },
      onClick: onClick ? (_, els) => els.length && onClick(els[0].index) : null,
      onHover: onClick ? (ev, els) => (ev.native.target.style.cursor = els.length ? "pointer" : "default") : null,
    },
  });
};

/* ======================================================================
   Copiar / baixar gráfico como PNG (para colar no PowerPoint)
   Gera uma imagem do cartão: título, subtítulo, legenda e o gráfico em alta resolução.
   ====================================================================== */
App.pngCartao = async function (cartao) {
  const ESC = 2.5;                                   // resolução final (2,5x)
  const canvas = cartao.querySelector("canvas");
  const chart = canvas ? Chart.getChart(canvas) : null;
  const titulo = cartao.querySelector(".cartao__titulo h3")?.textContent || "";
  let sub = (cartao.querySelector(".cartao__titulo .sub")?.textContent || "")
    .split(" · ").filter((p) => !/^clique/i.test(p)).join(" · ");
  const f = App.filtros;
  if ((f.de || f.ate) && !location.hash.includes("evento/") && !location.hash.includes("comparar")) {
    sub = [sub, `período ${f.de ? App.fmt.data(f.de) : "início"} a ${f.ate ? App.fmt.data(f.ate) : "hoje"}`].filter(Boolean).join(" · ");
  }
  const legenda = [...cartao.querySelectorAll(".legenda span")].map((s) => ({
    txt: s.textContent, cor: s.querySelector("i")?.style.background || App.cores.core, linha: s.querySelector("i")?.classList.contains("linha"),
  }));

  // 1) imagem do gráfico em alta resolução
  let img, wCss, hCss;
  if (chart) {
    const dprAntigo = chart.options.devicePixelRatio, anim = chart.options.animation;
    chart.options.devicePixelRatio = ESC;
    chart.options.animation = false;
    chart.resize();
    img = chart.canvas;
    wCss = chart.width; hCss = chart.height;
    const copia = document.createElement("canvas");
    copia.width = img.width; copia.height = img.height;
    copia.getContext("2d").drawImage(img, 0, 0);
    img = copia;
    chart.options.devicePixelRatio = dprAntigo;
    chart.options.animation = anim;
    chart.resize();
  } else {
    const blocos = cartao.querySelector(".blocos-tipo");
    if (!blocos) throw new Error("Nada para copiar neste cartão.");
    wCss = blocos.clientWidth; hCss = blocos.clientHeight;
    img = document.createElement("canvas");
    img.width = wCss * ESC; img.height = hCss * ESC;
    const c = img.getContext("2d");
    c.scale(ESC, ESC);
    const base = blocos.getBoundingClientRect();
    for (const b of blocos.children) {
      const r = b.getBoundingClientRect(), st = getComputedStyle(b);
      const x = r.left - base.left, y = r.top - base.top;
      c.fillStyle = st.backgroundColor;
      c.beginPath(); c.roundRect(x, y, r.width, r.height, 6); c.fill();
      c.fillStyle = st.color; c.textBaseline = "middle";
      c.font = `600 16px ${Chart.defaults.font.family}`;
      c.fillText(b.children[0].textContent, x + 18, y + r.height / 2);
      c.font = `600 17px ${Chart.defaults.font.family}`;
      const t = b.children[1].textContent;
      c.fillText(t, x + r.width - 18 - c.measureText(t).width, y + r.height / 2);
    }
  }

  // 2) monta o cartão
  const pad = 28, fam = Chart.defaults.font.family;
  const medir = document.createElement("canvas").getContext("2d");
  medir.font = `16px ${fam}`;
  const largura = Math.max(wCss + pad * 2, 480);
  // quebra a legenda em linhas
  const linhasLeg = [[]];
  let xAtual = 0;
  for (const l of legenda) {
    const w = 18 + medir.measureText(l.txt).width + 18;
    if (xAtual + w > largura - pad * 2 && linhasLeg[linhasLeg.length - 1].length) { linhasLeg.push([]); xAtual = 0; }
    linhasLeg[linhasLeg.length - 1].push({ ...l, w });
    xAtual += w;
  }
  const hTitulo = 30, hSub = sub ? 20 : 0, hLeg = legenda.length ? linhasLeg.length * 22 + 6 : 0;
  const topoGraf = pad + 10 + hTitulo + hSub + hLeg + 8;
  const altura = topoGraf + hCss + pad;
  const out = document.createElement("canvas");
  out.width = largura * ESC; out.height = altura * ESC;
  const c = out.getContext("2d");
  c.scale(ESC, ESC);
  c.fillStyle = "#FFFFFF"; c.fillRect(0, 0, largura, altura);
  c.fillStyle = App.cores.core; c.fillRect(pad, pad - 6, 48, 5);           // barrinha da marca
  c.fillStyle = App.cores.tinta; c.textBaseline = "top";
  c.font = `600 20px ${fam}`; c.fillText(titulo, pad, pad + 8);
  if (sub) { c.fillStyle = App.cores.tinta3; c.font = `16px ${fam}`; c.fillText(sub, pad, pad + 8 + hTitulo); }
  let y = pad + 10 + hTitulo + hSub;
  c.font = `16px ${fam}`;
  for (const lin of (legenda.length ? linhasLeg : [])) {
    let x = pad;
    for (const l of lin) {
      c.fillStyle = l.cor;
      if (l.linha) c.fillRect(x, y + 7, 14, 3); else { c.beginPath(); c.roundRect(x, y + 2, 12, 12, 3); c.fill(); }
      c.fillStyle = App.cores.tinta2; c.fillText(l.txt, x + 18, y + 1);
      x += l.w;
    }
    y += 22;
  }
  c.drawImage(img, pad, topoGraf, wCss, hCss);
  return await new Promise((res) => out.toBlob(res, "image/png"));
};

App.copiarCartao = async function (cartao, baixar = false) {
  try {
    const blob = await App.pngCartao(cartao);
    const podeCopiar = !baixar && window.isSecureContext && navigator.clipboard && window.ClipboardItem;
    if (podeCopiar) {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      App.toast("Gráfico copiado! Cole no PowerPoint com Ctrl+V.");
    } else {
      const nome = (cartao.querySelector(".cartao__titulo h3")?.textContent || "grafico").replace(/[^\w\-À-ú ]+/g, "").trim();
      const a = el("a", { href: URL.createObjectURL(blob), download: `${nome}.png` });
      document.body.append(a); a.click(); a.remove();
      App.toast(baixar ? "PNG baixado." : "Este navegador só permite copiar em http://localhost. O PNG foi baixado.");
    }
  } catch (e) { App.toast("Não consegui gerar a imagem: " + e.message, true); }
};

/** Coloca os botões Copiar / PNG em todo cartão que tenha gráfico. */
App.ferramentasGraficos = function (raiz) {
  raiz.querySelectorAll(".cartao").forEach((cartao) => {
    if (cartao.dataset.ferramentas || !(cartao.querySelector("canvas") || cartao.querySelector(".blocos-tipo"))) return;
    cartao.dataset.ferramentas = "1";
    let tit = cartao.querySelector(".cartao__titulo");
    if (!tit) return;
    let dir = tit.querySelector(".dir");
    if (!dir) { dir = el("div", { class: "dir" }); tit.append(dir); }
    dir.append(el("div", { class: "ferramentas" },
      el("button", { class: "btn btn--linha btn--mini", title: "Copiar como imagem (colar no PowerPoint)", onclick: () => App.copiarCartao(cartao) }, "Copiar"),
      el("button", { class: "btn btn--linha btn--mini", title: "Baixar PNG", onclick: () => App.copiarCartao(cartao, true) }, "Baixar PNG")));
  });
};

/* ======================================================================
   Exportar relatório (PDF pela janela de impressão do navegador)
   ====================================================================== */
/** Pergunta como as listas que abrem (por item, por evento…) entram no PDF. Devolve "tela" | "todas" | "nenhuma" | null. */
App.escolherListasPdf = () => new Promise((res) => {
  let feito = false;
  const fim = (v) => { if (!feito) { feito = true; App.fecharModal(); res(v); } };
  const op = (v, t, d) => el("button", { class: "entrada__opcao", type: "button", onclick: () => fim(v) }, el("span", {}, el("b", {}, t), el("small", {}, d)));
  App.modal(el("div", {}, el("h3", {}, "Exportar PDF"),
    el("p", { class: "ajuda", style: { marginTop: 0 } }, "Esta tela tem listas que abrem (por item, por evento…). Como elas devem sair no PDF?"),
    op("todas", "Lista completa", "Todas abertas: cada grupo com os seus detalhes logo abaixo."),
    op("nenhuma", "Só os totais", "Todas fechadas: uma linha por grupo, documento mais curto."),
    op("tela", "Como estão na tela", "Só os grupos que você abriu aparecem com detalhes."),
    el("div", { class: "linha-acoes" }, el("button", { class: "btn btn--linha", type: "button", onclick: () => fim(null) }, "Cancelar"))));
  const obs = new MutationObserver(() => { if (document.getElementById("modal").hidden) { obs.disconnect(); fim(null); } });
  obs.observe(document.getElementById("modal"), { attributes: true, attributeFilter: ["hidden"] });
});

App.exportarRelatorio = async function () {
  const raiz = document.getElementById("app");
  // listas que abrem: pergunta como entram no PDF
  let redesenhar = false;
  const exps = [...raiz.querySelectorAll(".tabela--exp")];
  if (exps.length) {
    const esc = await App.escolherListasPdf();
    if (!esc) return;
    if (esc !== "tela") {
      exps.forEach((t) => {
        const bloco = t.closest(".tabela-wrap")?.parentElement;
        const b = bloco && [...bloco.querySelectorAll(":scope > .linha-acoes button")].find((x) => x.textContent.includes(esc === "todas" ? "Expandir" : "Recolher"));
        if (b) b.click();
      });
      redesenhar = true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  // a página pode carregar tudo antes (ex.: todas as medições do filtro, não só a página atual)
  let desfazerPagina = null;
  if (App.antesDeExportar) { App.toast("Preparando o relatório…"); desfazerPagina = await App.antesDeExportar(); }
  // listas com "Mostrar mais": imprime todas as linhas
  for (let i = 0; i < 200; i++) {
    const mais = [...raiz.querySelectorAll(".tabela-mais")].find((b) => !b.hidden);
    if (!mais) break;
    mais.click();
  }
  const rotaAtual = location.hash.split("/")[1] || "visao";
  const area = { nf: "Notas fiscais", docs: "Documentos" }[rotaAtual];
  const titulo = (area ? area + " · " : "") + (raiz.querySelector(".pagina-cabecalho h2")?.textContent || "Relatório");
  const f = App.filtros, partes = [];
  const lerFiltro = (k) => { try { return JSON.parse(sessionStorage.getItem(k) || "{}"); } catch (e) { return {}; } };
  if (rotaAtual === "nf" && (location.hash.split("/")[2] || "medicoes") === "medicoes") {
    const m = lerFiltro("nf_filtro_med");
    if (m.de || m.ate) partes.push(`Medição de ${m.de ? App.fmt.data(m.de) : "início"} a ${m.ate ? App.fmt.data(m.ate) : "hoje"}`);
    if (m.status) partes.push("Status: " + m.status.toLowerCase());
    if (m.sla) partes.push("SLA: " + ({ "NO PRAZO": "no prazo", ATRASADO: "atrasadas", SEM: "atrasadas sem observação" })[m.sla]);
    if (m.q) partes.push(`Busca: "${m.q}"`);
  }
  if (rotaAtual === "nf" && location.hash.split("/")[2] === "graficos") {
    const [sAno, sForn] = raiz.querySelectorAll(".filtros select");
    if (sAno) partes.push("Ano: " + (sAno.value || "todos"));
    if (sForn && sForn.value) partes.push("Fornecedor: " + sForn.value);
  }
  if (rotaAtual === "docs") {
    const d = lerFiltro("docs_filtro");
    if (d.cat) partes.push("Categoria: " + d.cat.toLowerCase());
    if (d.sit) partes.push("Situação: " + d.sit.toLowerCase());
    if (d.q) partes.push(`Busca: "${d.q}"`);
  }
  if (["visao", "avarias", "manutencao"].includes(rotaAtual) && !location.hash.match(/(manutencao|avarias)\/\d/)) {
    partes.push(`Período: ${f.de ? App.fmt.data(f.de) : "início"} a ${f.ate ? App.fmt.data(f.ate) : "hoje"}`);
    if (f.categorias.length) partes.push("Categorias: " + f.categorias.map((c) => c || "Sem categoria").join(", "));
    if (f.genero) partes.push("Gênero: " + f.genero);
    if (rotaAtual === "visao" && f.componentes?.length) partes.push("Componentes: " + f.componentes.map((k) => App.NOMES_COMP[k] || k).join(", "));
    if (f.busca) partes.push(`Busca: "${f.busca}"`);
  }
  const ev = raiz.querySelector(".evento-topo h2");
  if (ev) partes.unshift(`${ev.textContent} · ${raiz.querySelector(".evento-topo .antetitulo")?.textContent || ""}`);
  const sel = [...raiz.querySelectorAll(".seletor input")].map((i) => i.value).filter(Boolean);
  if (rotaAtual === "comparar" && sel.length === 2) partes.unshift(`A: ${sel[0]}  ×  B: ${sel[1]}`);
  if (["manutencao", "avarias"].includes(rotaAtual) && sel[0] && !ev) partes.unshift(`Evento: ${sel[0]}`);

  const agora = new Date();
  const cab = el("div", { class: "cabecalho-impressao" },
    el("div", { class: "ci-marca" }, `ARENA DEMO · ${App.meta.setor || ""}`.toUpperCase()),
    el("h1", {}, `${App.meta.titulo} — ${titulo}`),
    el("div", { class: "ci-info" }, [...partes, `Gerado em ${agora.toLocaleDateString("pt-BR")} às ${agora.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`].join("   ·   ")));
  raiz.prepend(cab);

  // troca cada gráfico por uma imagem em alta resolução (o canvas não imprime bem)
  const trocas = [];
  for (const cv of raiz.querySelectorAll("canvas")) {
    const ch = Chart.getChart(cv);
    if (!ch) continue;
    const dpr = ch.options.devicePixelRatio, anim = ch.options.animation;
    ch.options.devicePixelRatio = 2.5; ch.options.animation = false; ch.resize();
    const img = el("img", { src: ch.toBase64Image("image/png", 1), class: "grafico-impresso", style: { width: ch.width + "px", maxWidth: "100%" } });
    ch.options.devicePixelRatio = dpr; ch.options.animation = anim; ch.resize();
    cv.style.display = "none";
    cv.parentNode.insertBefore(img, cv);
    trocas.push([cv, img]);
  }
  // tira dos subtítulos as dicas de tela ("clique para…")
  const subs = [...raiz.querySelectorAll(".cartao__titulo .sub")].map((s) => [s, s.textContent]);
  subs.forEach(([s, t]) => (s.textContent = t.split(" · ").filter((p) => !/^clique/i.test(p)).join(" · ")));
  const tituloAntigo = document.title;
  document.title = `${titulo} - ${agora.toLocaleDateString("pt-BR").replace(/\//g, "-")}`;  // nome sugerido do PDF
  const restaurar = () => {
    trocas.forEach(([cv, img]) => { img.remove(); cv.style.display = ""; });
    subs.forEach(([s, t]) => (s.textContent = t));
    cab.remove();
    document.title = tituloAntigo;
    if (typeof desfazerPagina === "function") desfazerPagina();
    window.removeEventListener("afterprint", restaurar);
    if (redesenhar) App.rotear();
  };
  window.addEventListener("afterprint", restaurar);
  await new Promise((r) => setTimeout(r, 120));
  window.print();
  setTimeout(() => { if (cab.isConnected && !matchMedia("print").matches) restaurar(); }, 1500);
};
