/* Núcleo: API, formatação, componentes compartilhados (filtros, seletor de evento, tabela, modal). */
"use strict";

const App = {
  meta: {},
  eventos: [],          // lista com totais (cache)
  filtros: { de: "", ate: "", categorias: [], genero: "", busca: "", componentes: [] },
  paginas: {},
};

/* ------------------------------------------------------------------ cores (validadas p/ daltonismo) */
App.cores = {
  componente: { MDO: "#6A0BB0", INSUMOS: "#2F6B1C", AVARIAS: "#A876F0", RELOGIOS: "#4F8F33" },
  relogio: { "ELÉTRICA": "#6A0BB0", "ÁGUA": "#4F8F33", "GÁS": "#A876F0", "POÇO": "#2F6B1C", "IRRIGAÇÃO": "#7DB565" },
  categoria: { SHOW: "#8D0DE3", JOGO: "#2F6B1C", "PROJETO ESPECIAL": "#A876F0", "": "#9A92A6" },
  A: "#8D0DE3", B: "#4F8F33",
  rampa: ["#1E002F", "#420465", "#5E0A99", "#8D0DE3", "#A876F0", "#CBA5FD", "#E4D2FE"],
  core: "#8D0DE3", tinta: "#1E002F", tinta2: "#4E4459", tinta3: "#7B7286", linha: "#EFE8F7",
};
/* Tema: verde quando o foco é JOGO, roxo nos demais casos.
   As paletas são copiadas para dentro de App.cores (mesmos objetos), então quem já guardou
   App.cores.relogio / .componente continua apontando para as cores certas. */
App.PALETAS = {
  roxo: {
    componente: { MDO: "#6A0BB0", INSUMOS: "#2F6B1C", AVARIAS: "#A876F0", RELOGIOS: "#4F8F33" },
    relogio: { "ELÉTRICA": "#6A0BB0", "ÁGUA": "#4F8F33", "GÁS": "#A876F0", "POÇO": "#2F6B1C", "IRRIGAÇÃO": "#7DB565" },
    A: "#8D0DE3", B: "#4F8F33", destaque: "#420465",
    rampa: ["#1E002F", "#420465", "#5E0A99", "#8D0DE3", "#A876F0", "#CBA5FD", "#E4D2FE"],
    core: "#8D0DE3", tinta: "#1E002F", tinta2: "#4E4459", tinta3: "#7B7286", linha: "#EFE8F7", borda: "#D8CAEA", guia: "#B9A6D3", tooltip: "#1E002F", tooltipTexto: "#ECDFFF",
  },
  verde: {
    componente: { MDO: "#174006", INSUMOS: "#7DB565", AVARIAS: "#3C7A24", RELOGIOS: "#B5D9A4" },
    relogio: { "ELÉTRICA": "#174006", "ÁGUA": "#5A9A3E", "GÁS": "#2F6B1C", "POÇO": "#A7D296", "IRRIGAÇÃO": "#7B7286" },
    A: "#174006", B: "#7DB565", destaque: "#0C2403",
    rampa: ["#0C2403", "#174006", "#2F6B1C", "#4F8F33", "#7DB565", "#A7D296", "#D4EBCA"],
    core: "#2F6B1C", tinta: "#0F2208", tinta2: "#44513F", tinta3: "#6E7A69", linha: "#E4F0DE", borda: "#C3DBB8", guia: "#9FBF91", tooltip: "#0C2403", tooltipTexto: "#E3F2DC",
  },
};
App.tema = "roxo";
App.aplicarTema = function (jogo) {
  const nome = jogo ? "verde" : "roxo";
  const p = App.PALETAS[nome];
  for (const [k, v] of Object.entries(p)) {
    if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(App.cores[k] || (App.cores[k] = {}), v);
    else if (Array.isArray(v)) { App.cores[k] = App.cores[k] || []; App.cores[k].splice(0, App.cores[k].length, ...v); }
    else App.cores[k] = v;
  }
  if (jogo) document.documentElement.dataset.tema = "jogo"; else delete document.documentElement.dataset.tema;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = p.core;
  if (window.Chart) {
    Chart.defaults.color = p.tinta2;
    Chart.defaults.borderColor = p.linha;
    const tt = Chart.defaults.plugins.tooltip;
    Object.assign(tt, { backgroundColor: p.tooltip, bodyColor: p.tooltipTexto });
  }
  App.tema = nome;
};
/** Foco é jogo? evento(s) da categoria JOGO, ou lista de categorias filtradas = só JOGO. */
App.ehJogo = (...evs) => evs.length > 0 && evs.every((e) => e && (e.categoria || "").toUpperCase() === "JOGO");
App.filtroSoJogo = (cats = App.filtros.categorias) => cats.length === 1 && (cats[0] || "").toUpperCase() === "JOGO";

App.corCategoria = (c) => App.cores.categoria[c || ""] || App.cores.categoria[""];
App.NOMES_COMP = { MDO: "MDO", INSUMOS: "Insumos", AVARIAS: "Avarias", RELOGIOS: "Medidores" };

/* ------------------------------------------------------------------ API */
App.api = async function (url, opts = {}) {
  const o = { headers: {}, ...opts };
  if (o.json !== undefined) {
    o.body = JSON.stringify(o.json);
    o.headers["Content-Type"] = "application/json";
    delete o.json;
  }
  const r = await fetch(url, o);
  let dados = null;
  const tipo = r.headers.get("content-type") || "";
  if (tipo.includes("json")) dados = await r.json();
  if (!r.ok) throw new Error((dados && dados.erro) || `Erro ${r.status}`);
  return dados;
};

App.carregarEventos = async function () {
  App.eventos = await App.api("/api/eventos");
  App.avarias = null;   // força recarregar a página de avarias
  return App.eventos;
};

/* ------------------------------------------------------------------ formatação */
const fBRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const fNum = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });
const fNum1 = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
App.fmt = {
  brl: (v) => fBRL.format(v || 0),
  brlCurto(v) {
    v = v || 0;
    const a = Math.abs(v);
    if (a >= 1e6) return "R$ " + fNum1.format(v / 1e6) + " mi";
    if (a >= 1e3) return "R$ " + fNum1.format(v / 1e3) + " mil";
    return "R$ " + fNum1.format(v);
  },
  eixo(v) {
    const a = Math.abs(v);
    if (a >= 1e6) return fNum.format(v / 1e6) + " mi";
    if (a >= 1e3) return fNum.format(v / 1e3) + " mil";
    return fNum.format(v);
  },
  num: (v) => fNum.format(v || 0),
  pct: (v) => (v === null || v === undefined ? "—" : fNum1.format(v) + "%"),
  data(iso) {
    if (!iso) return "";
    const [a, m, d] = iso.split("-");
    return `${d}/${m}/${a}`;
  },
  dataCurta(iso) {
    if (!iso) return "";
    const [a, m, d] = iso.split("-");
    return `${d}/${m}/${a.slice(2)}`;
  },
  min(m) {
    if (m === null || m === undefined || isNaN(m)) return "—";
    const t = Math.round(m);
    return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
  },
  rotuloEvento: (e) => `${e.nome} · ${App.fmt.dataCurta(e.data)}`,
};

/* ------------------------------------------------------------------ DOM helper (sempre textContent) */
App.el = function (tag, attrs = {}, ...filhos) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(n.style, v);
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (k === "html") n.innerHTML = v; // apenas para marcação fixa nossa
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const f of filhos.flat()) {
    if (f === null || f === undefined || f === false) continue;
    n.append(f instanceof Node ? f : document.createTextNode(String(f)));
  }
  if (typeof (attrs || {}).onclick === "function") App.tornarClicavel(n);
  return n;
};
const el = App.el;
/** Data no fuso do computador (toISOString usa UTC: das 21h em diante já virava o dia seguinte). */
App.iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
App.hoje = () => App.iso(new Date());

/* ------------------------------------------------------------------ teclado: tudo que é clicável também funciona com Tab + Enter/Espaço */
const INTERATIVO = "a[href], button, input, select, textarea, label, summary, option, canvas, [contenteditable]";
App.tornarClicavel = (n) => {
  if (!n || !n.matches || n.matches(INTERATIVO) || n.dataset.tecla) return;
  n.dataset.tecla = "1";
  n.classList.add("clicavel");
  if (!n.hasAttribute("tabindex")) n.tabIndex = 0;
  if (!n.hasAttribute("role") && !/^(TR|TH|TD)$/.test(n.tagName)) n.setAttribute("role", "button");
};
// x.onclick = ... também deixa o elemento focável pelo teclado
(() => {
  const d = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "onclick");
  if (!d || !d.set) return;
  Object.defineProperty(HTMLElement.prototype, "onclick", {
    configurable: true, enumerable: d.enumerable,
    get() { return d.get.call(this); },
    set(f) { d.set.call(this, f); if (f) App.tornarClicavel(this); },
  });
})();

App.limpar = (n) => { while (n.firstChild) n.removeChild(n.firstChild); return n; };
App.blocos = () => el("div", { class: "blocos", "aria-hidden": "true" }, ...Array.from({ length: 7 }, () => el("i")));

/* ------------------------------------------------------------------ ajuda (botão "?") */
/** Texto de ajuda: string com parágrafos separados por linha em branco, "- " vira item de lista e **x** vira negrito. */
App.textoAjuda = function (t) {
  const caixa = el("div", { class: "ajuda-pop__texto" });
  const inline = (s) => { const sp = el("span"); sp.innerHTML = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>"); return sp; };
  for (const bloco of String(t).trim().split(/\n\s*\n/)) {
    const linhas = bloco.split("\n").map((x) => x.trim()).filter(Boolean);
    if (linhas.every((x) => x.startsWith("- "))) caixa.append(el("ul", {}, linhas.map((x) => el("li", {}, inline(x.slice(2))))));
    else caixa.append(el("p", {}, inline(linhas.join(" "))));
  }
  return caixa;
};
App.fecharAjuda = () => { document.querySelectorAll(".ajuda-pop").forEach((x) => x.remove()); };
/** Botão "?" que abre a explicação ao lado (não fecha janelas abertas). */
App.botaoAjuda = function (texto, titulo = "") {
  const b = el("button", { class: "btn-ajuda", type: "button", "aria-label": "O que é isto?" + (titulo ? " " + titulo : ""), title: "O que é isto?" }, "?");
  b.addEventListener("click", (ev) => {
    ev.stopPropagation(); ev.preventDefault();
    const aberto = document.querySelector(`.ajuda-pop[data-de="${b.dataset.id}"]`);
    App.fecharAjuda();
    if (aberto) return;
    b.dataset.id = b.dataset.id || String(Math.random()).slice(2);
    const fechar = el("button", { class: "ajuda-pop__fechar", type: "button", "aria-label": "Fechar" }, "×");
    const pop = el("div", { class: "ajuda-pop", role: "dialog", "data-de": b.dataset.id }, fechar, titulo ? el("b", { class: "ajuda-pop__titulo" }, titulo) : null,
      App.textoAjuda(typeof texto === "function" ? texto() : texto));
    fechar.onclick = (e) => { e.stopPropagation(); pop.remove(); b.focus(); };
    pop.addEventListener("click", (e) => e.stopPropagation());
    document.body.append(pop);
    const r = b.getBoundingClientRect(), w = Math.min(460, window.innerWidth - 24);
    pop.style.width = w + "px";
    pop.style.left = Math.max(12, Math.min(r.left + window.scrollX - 20, window.scrollX + window.innerWidth - w - 12)) + "px";
    pop.style.top = (r.bottom + window.scrollY + 8) + "px";
    fechar.focus();
  });
  return b;
};
document.addEventListener("click", () => App.fecharAjuda());
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") App.fecharAjuda(); });

/** Ajuda dos cartões: App.AJUDA = [[início do título (sem acento, minúsculo) ou RegExp, texto]] (arquivo ajuda.js). */
App.ajudaDoTitulo = function (titulo, lista) {
  const t = App.norm(typeof titulo === "string" ? titulo : (titulo && titulo.textContent) || "").trim();
  for (const [k, txt] of (lista || App.AJUDA) || []) {
    if (k instanceof RegExp ? k.test(t) : t === App.norm(k) || t.startsWith(App.norm(k) + " ")) return typeof txt === "function" ? txt(t) : txt;
  }
  return null;
};
App.cartao = (titulo, sub, ...filhos) => {
  const ajuda = App.ajudaDoTitulo(titulo);
  return el("section", { class: "cartao" },
    el("div", { class: "cartao__titulo" }, el("h3", {}, titulo, ajuda ? App.botaoAjuda(ajuda, typeof titulo === "string" ? titulo : "") : null),
      sub ? el("span", { class: "sub" }, sub) : null),
    ...filhos);
};

App.kpi = (rotulo, valor, estilo = "p100", nota = null, ajuda = null) => {
  const txt = ajuda || App.ajudaDoTitulo(rotulo, App.AJUDA_KPI);
  return el("div", { class: `kpi kpi--${estilo}` },
    el("div", { class: "kpi__rotulo" }, rotulo, txt ? App.botaoAjuda(txt, typeof rotulo === "string" ? rotulo : "") : null),
    el("div", {}, el("div", { class: "kpi__valor" }, valor), nota ? el("div", { class: "kpi__nota" }, nota) : null));
};

/* ------------------------------------------------------------------ toast / modal */
App.toast = function (msg, erro = false) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast vis" + (erro ? " erro" : "");
  clearTimeout(App._tt);
  App._tt = setTimeout(() => (t.className = "toast"), 3200);
};

/* Modal. Não fecha por clique fora da caixa (um clique errado ou soltar o mouse fora ao selecionar texto
   apagava o que estava sendo preenchido). Fecha pelo ×, por Cancelar ou por Esc; se algo já foi digitado,
   pergunta antes de descartar. */
App._modal = { sujo: false, origem: null };
App.modal = function (conteudo) {
  const m = document.getElementById("modal");
  const corpo = App.limpar(document.getElementById("modal-corpo"));
  if (m.hidden) App._modal.origem = document.activeElement;   // para devolver o foco ao fechar
  App._modal.sujo = false;
  m.querySelector(".modal__aviso")?.remove();
  corpo.append(conteudo);
  const tit = corpo.querySelector("h3");
  const caixa = m.querySelector(".modal__caixa");
  if (tit) { tit.id = "modal-titulo"; caixa.setAttribute("aria-labelledby", "modal-titulo"); } else caixa.removeAttribute("aria-labelledby");
  m.hidden = false;
  caixa.scrollTop = 0;   // a caixa é a mesma entre janelas: não herda a rolagem da anterior
  const f = corpo.querySelector("input:not([type=hidden]):not([hidden]), select, textarea, button, [tabindex]:not([tabindex='-1'])");
  setTimeout(() => (f || caixa).focus(), 30);
  return () => App.fecharModal();
};
/** Fecha sem perguntar (usado depois de salvar). */
App.fecharModal = () => {
  const m = document.getElementById("modal");
  if (m.hidden) return;
  m.hidden = true;
  m.querySelector(".modal__aviso")?.remove();
  App._modal.sujo = false;
  const o = App._modal.origem;
  App._modal.origem = null;
  if (o && document.body.contains(o) && o.focus) o.focus();
};
/** Fechamento pedido pela pessoa (×, Cancelar, Esc): se há dados preenchidos, confirma antes. */
App.pedirFecharModal = () => {
  const m = document.getElementById("modal");
  if (m.hidden) return;
  if (!App._modal.sujo) return App.fecharModal();
  const caixa = m.querySelector(".modal__caixa");
  let aviso = caixa.querySelector(".modal__aviso");
  if (!aviso) {
    const continuar = el("button", { class: "btn btn--linha btn--mini", type: "button", onclick: () => { aviso.remove(); App._modal.focoAntes?.focus(); } }, "Continuar editando");
    aviso = el("div", { class: "modal__aviso", role: "alertdialog", "aria-label": "Descartar alterações?" },
      el("span", {}, "Há informações preenchidas que ainda não foram salvas. Descartar?"),
      el("div", { class: "linha-acoes" }, continuar,
        el("button", { class: "btn btn--perigo btn--mini", type: "button", onclick: () => App.fecharModal() }, "Descartar")));
    App._modal.focoAntes = document.activeElement;
    caixa.prepend(aviso);
    aviso.scrollIntoView({ block: "nearest" });
    continuar.focus();
  } else aviso.querySelector("button").focus();
};
document.getElementById("modal-corpo").addEventListener("input", (e) => { if (e.isTrusted) App._modal.sujo = true; });
document.getElementById("modal-corpo").addEventListener("change", (e) => { if (e.isTrusted) App._modal.sujo = true; });
document.addEventListener("click", (e) => {
  const f = e.target.closest("[data-fechar]");
  if (!f || !f.closest("#modal")) return;
  if (f.tagName === "A") App.fecharModal();          // link que leva para outra tela: só fecha
  else App.pedirFecharModal();
});

App.confirmar = (titulo, texto, rotuloOk = "Confirmar") =>
  new Promise((res) => {
    const ok = el("button", { class: "btn btn--perigo", onclick: () => { App.fecharModal(); res(true); } }, rotuloOk);
    App.modal(el("div", {}, el("h3", {}, titulo), el("p", {}, texto),
      el("div", { class: "linha-acoes" }, ok,
        el("button", { class: "btn btn--linha", onclick: () => { App.fecharModal(); res(false); } }, "Cancelar"))));
  });

App.perguntar = (titulo, rotulo, tipo = "text", valor = "") =>
  new Promise((res) => {
    const inp = el("input", { type: tipo, value: valor, style: { width: "100%" } });
    const enviar = () => { App.fecharModal(); res(inp.value); };
    inp.addEventListener("keydown", (e) => e.key === "Enter" && enviar());
    App.modal(el("div", {}, el("h3", {}, titulo),
      el("label", { class: "campo" }, el("span", {}, rotulo), inp),
      el("div", { class: "linha-acoes" }, el("button", { class: "btn", onclick: enviar }, "OK"),
        el("button", { class: "btn btn--linha", onclick: () => { App.fecharModal(); res(null); } }, "Cancelar"))));
  });

/* ------------------------------------------------------------------ normalização p/ busca */
App.norm = (s) => (s || "").toString().normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/* ------------------------------------------------------------------ filtros globais */
try { Object.assign(App.filtros, JSON.parse(localStorage.getItem("rge_filtros") || "{}")); } catch (e) { /* sem storage */ }
if (!Array.isArray(App.filtros.componentes)) App.filtros.componentes = [];
/* Componentes de custo (filtro da Visão geral). Vazio = todos. */
App.COMPONENTES = [["MDO", "mdo"], ["AVARIAS", "avarias"], ["INSUMOS", "insumos"], ["RELOGIOS", "relogios"]];
App.compsAtivos = (f = App.filtros) => App.COMPONENTES.filter(([k]) => !f.componentes.length || f.componentes.includes(k));
App.totalComps = (e, comps = App.compsAtivos()) => comps.reduce((s, [, campo]) => s + (e[campo] || 0), 0);
App.salvarFiltros = () => { try { localStorage.setItem("rge_filtros", JSON.stringify(App.filtros)); } catch (e) { /* ok */ } };

/** Texto dos filtros da tela (período, categorias, gênero, busca), para cabeçalhos de PDF e Excel. */
App.textoFiltros = function (f = App.filtros) {
  const p = [`Período: ${f.de ? App.fmt.data(f.de) : "início"} a ${f.ate ? App.fmt.data(f.ate) : "hoje"}`];
  if (f.categorias.length) p.push("Categorias: " + f.categorias.map((c) => c || "Sem categoria").join(", "));
  if (f.genero) p.push("Gênero: " + f.genero);
  if (f.busca) p.push(`Busca: "${f.busca}"`);
  return p.join(" · ");
};
/** Endereço do Excel "relatório desta tela": manda os eventos do filtro (os mesmos da tela). */
App.urlExcelTela = function (rota, params = []) {
  const q = new URLSearchParams({ pagina: rota });
  const id = params[0] && /^\d+$/.test(params[0]) ? +params[0] : null;
  let ids, texto;
  if (rota === "comparar") { ids = params.filter((x) => /^\d+$/.test(x)).map(Number); texto = ids.map((i) => { const e = App.eventos.find((x) => x.id === i); return e ? `${e.nome} ${App.fmt.data(e.data)}` : ""; }).join("  ×  "); }
  else if (id && (rota === "evento" || rota === "avarias" || rota === "manutencao")) {
    ids = [id]; const e = App.eventos.find((x) => x.id === id); texto = e ? `Evento: ${e.nome} · ${App.fmt.data(e.data)}` : "";
    if (rota === "evento") q.set("pagina", "evento");
  } else {
    const comBusca = rota === "visao";   // nas avarias e na manutenção a busca vale para item / descrição: vai à parte
    ids = App.filtrarEventos(App.eventos, comBusca ? App.filtros : { ...App.filtros, busca: "" }).map((e) => e.id);
    if (!comBusca && App.filtros.busca) q.set("q", App.filtros.busca);
    texto = App.textoFiltros();
  }
  if (rota === "evento" && !id) ids = App.eventos.slice(0, 1).map((e) => e.id);
  if (ids && ids.length !== App.eventos.length) q.set("ids", ids.join(","));
  q.set("filtros", texto || "");
  return "/api/exportar/relatorio?" + q.toString();
};

App.filtrarEventos = function (lista = App.eventos, f = App.filtros) {
  const q = App.norm(f.busca);
  return lista.filter((e) =>
    (!f.de || e.data >= f.de) && (!f.ate || e.data <= f.ate) &&
    (!f.categorias.length || f.categorias.includes(e.categoria || "")) &&
    (!f.genero || e.genero === f.genero) &&
    (!q || App.norm(`${e.nome} ${e.genero} ${e.categoria} ${App.fmt.data(e.data)}`).includes(q)));
};

/** Barra de filtros (período, categoria, gênero, busca). onChange é chamado a cada mudança. */
App.barraFiltros = function (onChange, opcoes = {}) {
  const f = App.filtros;
  const de = el("input", { type: "date", value: f.de });
  const ate = el("input", { type: "date", value: f.ate });
  const genero = el("select", {}, el("option", { value: "" }, "Todos"),
    ...App.meta.generos.map((g) => el("option", { value: g, selected: g === f.genero }, g)));
  const busca = el("input", { type: "search", placeholder: opcoes.placeholder || "Buscar evento, gênero, data…", value: f.busca });
  const disparar = () => { App.salvarFiltros(); onChange(); };

  const ano = new Date().getFullYear();
  const hoje = App.hoje();
  const menos = (d) => { const x = new Date(); x.setDate(x.getDate() - d); return App.iso(x); };
  const presets = [
    ["30 dias", menos(30), hoje], ["90 dias", menos(90), hoje],
    [String(ano), `${ano}-01-01`, `${ano}-12-31`], [String(ano - 1), `${ano - 1}-01-01`, `${ano - 1}-12-31`], ["Tudo", "", ""],
  ];
  const btnsPreset = presets.map(([r, a, b]) => {
    const btn = el("button", { class: "chip chip--mini", "aria-pressed": String(f.de === a && f.ate === b) }, r);
    btn.onclick = () => { f.de = a; f.ate = b; de.value = a; ate.value = b; marcarPresets(); disparar(); };
    return btn;
  });
  const marcarPresets = () => btnsPreset.forEach((b, i) =>
    b.setAttribute("aria-pressed", String(f.de === presets[i][1] && f.ate === presets[i][2])));

  const cats = [...App.meta.categorias, ...(App.eventos.some((e) => !e.categoria) ? [""] : [])];
  const chips = cats.map((c) => {
    const b = el("button", { class: "chip", "aria-pressed": String(f.categorias.includes(c)) },
      el("i", { style: { background: App.corCategoria(c) } }), c || "Sem categoria");
    b.onclick = () => {
      const i = f.categorias.indexOf(c);
      i >= 0 ? f.categorias.splice(i, 1) : f.categorias.push(c);
      b.setAttribute("aria-pressed", String(i < 0));
      App.aplicarTema(App.filtroSoJogo(f.categorias));
      disparar();
    };
    return b;
  });

  de.onchange = () => { f.de = de.value; marcarPresets(); disparar(); };
  ate.onchange = () => { f.ate = ate.value; marcarPresets(); disparar(); };
  genero.onchange = () => { f.genero = genero.value; disparar(); };
  let tb;
  busca.oninput = () => { clearTimeout(tb); tb = setTimeout(() => { f.busca = busca.value; disparar(); }, 180); };

  const limpar = el("button", { class: "btn btn--linha btn--mini limpar" }, "Limpar filtros");
  limpar.onclick = () => {
    Object.assign(f, { de: "", ate: "", categorias: [], genero: "", busca: "", componentes: [] });
    App.salvarFiltros();
    App.aplicarTema(false);
    onChange(true);
  };

  // filtro de componentes de custo (só onde a página pede: Visão geral)
  let campoComp = null;
  if (opcoes.componentes) {
    const temIns = App.eventos.some((e) => e.insumos > 0) || f.componentes.includes("INSUMOS");
    const chipsComp = App.COMPONENTES.filter(([k]) => k !== "INSUMOS" || temIns).map(([k]) => {
      const b = el("button", { class: "chip", "aria-pressed": String(f.componentes.includes(k)), title: "Clique para mostrar só este componente (pode marcar vários; nenhum = todos)" },
        el("i", { style: { background: App.cores.componente[k] } }), App.NOMES_COMP[k]);
      b.onclick = () => {
        const i = f.componentes.indexOf(k);
        i >= 0 ? f.componentes.splice(i, 1) : f.componentes.push(k);
        b.setAttribute("aria-pressed", String(i < 0));
        disparar();
      };
      return b;
    });
    campoComp = el("div", { class: "campo" }, el("span", {}, "Componentes (nenhum = todos)"), el("div", { class: "chips" }, chipsComp));
  }

  return App.filtrosEnxutos(el("div", { class: "filtros" },
    el("label", { class: "campo" }, el("span", {}, "Período"), el("div", { class: "presets" }, de, ate)),
    el("div", { class: "campo" }, el("span", {}, "Atalhos"), el("div", { class: "presets" }, btnsPreset)),
    el("div", { class: "campo" }, el("span", {}, "Categoria"), el("div", { class: "chips" }, chips)),
    campoComp,
    el("label", { class: "campo" }, el("span", {}, "Gênero"), genero),
    el("label", { class: "campo campo--cresce" }, el("span", {}, "Busca"), el("div", { class: "busca" }, busca)),
    limpar));
};

/* ------------------------------------------------------------------ padrão das páginas
   Todas as telas seguem a mesma ordem:
   1. cabeçalho: título + descrição | à direita: botão principal primeiro · Exportar · "Mais ações" (App.organizarAcoes). Antes: Exportar · Importar Excel · Baixar modelo Excel · ações da tela · botão principal
   2. avisos (faixas coloridas)
   3. cartão de filtros: campos · Busca (sempre por último, ocupa o resto) · Limpar filtros
   4. números (KPIs)
   5. conteúdo (gráficos e tabelas, separados por títulos de seção) */
/** Põe botões no lado direito do cabeçalho da página (antes do botão principal, que fica por último). */
App.acoesCabecalho = function (...nos) {
  const cab = document.querySelector("#app .pagina-cabecalho");
  if (!cab) return;
  let ac = cab.querySelector(".acoes");
  if (!ac) { ac = el("div", { class: "acoes" }); cab.append(ac); }
  ac.append(...nos.flat().filter(Boolean));
};
/** Filtros das telas com "Evento específico": o seletor de evento vira o primeiro campo do cartão de filtros. */
App.filtrosComEvento = function (eventoId, seletor, limparEv, barra) {
  const campoEv = el("label", { class: "campo campo--evento" }, el("span", {}, "Evento específico"), seletor);
  if (eventoId) return el("div", { class: "filtros" }, campoEv, el("div", { class: "campo" }, el("span", {}, " "), limparEv));
  const f = barra();
  f.prepend(campoEv);
  return f;
};
/** Menu suspenso aberto: encosta do lado que couber, para nunca sair da tela nem criar rolagem lateral. */
App.menuNaTela = function (menu) {
  menu.style.left = menu.style.right = "";
  if (menu.hidden) return;
  const r = menu.getBoundingClientRect();
  if (r.right > document.documentElement.clientWidth - 8) { menu.style.left = "auto"; menu.style.right = "0"; }
  else if (r.left < 8) { menu.style.left = "0"; menu.style.right = "auto"; }
};
/** Um botão "Exportar" só, com as opções PDF (relatório da tela) e Excel (dados da tela). */
App.botaoExportar = function () {
  const xl = App.exportarExcel;
  const menu = el("div", { class: "menu-exportar", hidden: true, role: "menu" });
  const item = (titulo, sub, acao) => el("button", { class: "menu-exportar__item", role: "menuitem", onclick: () => { menu.hidden = true; acao(); } },
    el("b", {}, titulo), el("small", {}, sub));
  menu.append(item("PDF", "relatório desta tela, com gráficos e tabelas", () => App.exportarRelatorio()));
  // uma ou várias opções de Excel: { titulo?, rotulo, url | () => url }
  (Array.isArray(xl) ? xl : xl ? [xl] : []).forEach((x) =>
    menu.append(item(x.titulo || "Excel", x.rotulo, () => { location.href = typeof x.url === "function" ? x.url() : x.url; })));
  const btn = el("button", { class: "btn btn--sec", "aria-haspopup": "menu", onclick: (ev) => { ev.stopPropagation(); menu.hidden = !menu.hidden; App.menuNaTela(menu); btn.setAttribute("aria-expanded", String(!menu.hidden)); if (!menu.hidden && ev.detail === 0) menu.querySelector("button")?.focus(); } }, "Exportar ", el("span", { class: "seta-menu" }, "▾"));
  const caixa = el("div", { class: "exportar" }, btn, menu);
  document.addEventListener("click", (ev) => { if (!caixa.contains(ev.target)) menu.hidden = true; });
  return caixa;
};
/** Campo com rótulo (padrão dos filtros e formulários). */
App.campo = (rotulo, ...conteudo) => el("label", { class: "campo" }, el("span", {}, rotulo), ...conteudo);
/** Cartão de filtros padrão: campos, busca por último e "Limpar filtros". */
App.barraPadrao = function ({ campos = [], busca = null, rotuloBusca = "Busca", limpar = null } = {}) {
  const btn = limpar ? el("button", { class: "btn btn--linha btn--mini limpar", onclick: limpar }, "Limpar filtros") : null;
  return App.filtrosEnxutos(el("div", { class: "filtros" }, ...campos.filter(Boolean),
    busca ? el("label", { class: "campo campo--cresce" }, el("span", {}, rotuloBusca), el("div", { class: "busca" }, busca)) : null, btn));
};

/* ------------------------------------------------------------------ seletor de evento (com busca) */
App.seletorEvento = function ({ valor = null, placeholder = "Buscar evento…", onSelect, lista = null }) {
  const fonte = () => lista || App.eventos;
  const inp = el("input", { type: "text", placeholder, autocomplete: "off" });
  const caixa = el("div", { class: "seletor__lista", hidden: true });
  const raiz = el("div", { class: "seletor busca" }, inp, caixa);
  let atual = null, foco = -1, itens = [];

  const definir = (e, disparar = true) => {
    atual = e;
    inp.value = e ? App.fmt.rotuloEvento(e) : "";
    caixa.hidden = true;
    if (disparar && onSelect) onSelect(e);
  };
  const desenhar = () => {
    const q = App.norm(inp.value);
    const termos = q.split(/\s+/).filter(Boolean);
    itens = fonte().filter((e) => {
      const t = App.norm(`${e.nome} ${App.fmt.data(e.data)} ${e.categoria} ${e.genero}`);
      return termos.every((x) => t.includes(x));
    }).slice(0, 80);
    App.limpar(caixa);
    if (!itens.length) caixa.append(el("div", { class: "seletor__item" }, "Nenhum evento encontrado"));
    itens.forEach((e, i) => {
      caixa.append(el("div", {
        class: "seletor__item" + (i === foco ? " foco" : ""),
        onmousedown: (ev) => { ev.preventDefault(); definir(e); },
      }, el("span", { class: "ponto", style: { background: App.corCategoria(e.categoria) } }),
        el("span", {}, e.nome), el("small", {}, `${App.fmt.data(e.data)} · ${App.fmt.brlCurto(e.total)}`)));
    });
    caixa.hidden = false;
  };
  inp.addEventListener("focus", () => { inp.select(); foco = -1; desenhar(); });
  inp.addEventListener("input", () => { foco = 0; desenhar(); });
  inp.addEventListener("blur", () => setTimeout(() => { caixa.hidden = true; if (atual) inp.value = App.fmt.rotuloEvento(atual); }, 120));
  inp.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown") { foco = Math.min(foco + 1, itens.length - 1); desenhar(); ev.preventDefault(); }
    else if (ev.key === "ArrowUp") { foco = Math.max(foco - 1, 0); desenhar(); ev.preventDefault(); }
    else if (ev.key === "Enter" && itens[foco]) { definir(itens[foco]); inp.blur(); }
  });
  if (valor) definir(valor, false);
  raiz.definir = definir;
  return raiz;
};

/* ------------------------------------------------------------------ tabela ordenável */
/** colunas: [{rotulo, valor:(linha)=>any, render?:(linha)=>Node|string, num?:bool, total?:fn}] */
/** Barra de seleção ("3 selecionado(s) · Excluir selecionados · Limpar seleção"). sel: Set de ids. */
App.barraSelecao = function (sel, { nome = "item(ns)", acoes = [], aoLimpar = () => {} } = {}) {
  const txt = el("b");
  const barra = el("div", { class: "barra-selecao", hidden: true }, txt,
    el("div", { class: "barra-selecao__acoes" }, ...acoes,
      el("button", { class: "btn btn--mini btn--linha", onclick: () => { sel.clear(); aoLimpar(); barra.atualizar(); } }, "Limpar seleção")));
  barra.atualizar = () => { barra.hidden = !sel.size; txt.textContent = `${sel.size} ${nome} selecionado(s)`; };
  return barra;
};
/** Caixa de seleção (checkbox) padrão das tabelas. */
App.caixaSel = (marcado, aoMudar, titulo = "Selecionar") => {
  const c = el("input", { type: "checkbox", class: "caixa-sel", checked: !!marcado, title: titulo, "aria-label": titulo });
  c.addEventListener("click", (ev) => ev.stopPropagation());
  c.addEventListener("change", () => aoMudar(c.checked));
  return c;
};

/** Tabela com ordenação. selecao: { id: (l) => id, nome, acoes: (ids, limpar) => [botões] } põe caixas de seleção e a barra de ações em lote. */
/* ------------------------------------------------------------------ escolher colunas (ocultar / mostrar) */
/* Toda tabela com 3+ colunas ganha o botão "Colunas". A escolha fica guardada neste navegador, por tela e tabela.
   Coluna com { fixa: true } não pode ser ocultada; coluna com { controle: { visivel, mudar(v) } } é controlada pela página
   (ex.: poço artesiano no rateio, que muda o cálculo). */
App.rotuloCol = (c) => (typeof c.rotulo === "string" ? c.rotulo.trim() : "");
App.colOcultavel = (c, i) => i > 0 && !!App.rotuloCol(c) && c.classe !== "col-sel" && !c.fixa;
App.chaveColunas = (cols) => "colunas:" + location.hash.replace(/^#\/?/, "").split("/").slice(0, 2).join("/") + "|"
  + cols.map(App.rotuloCol).filter(Boolean).join("|");
/** colunas ocultas guardadas; sem escolha guardada, usa as marcadas com { oculta: true } (começam escondidas para a tabela caber na tela) */
App.lerOcultas = (k, cols = []) => {
  const padrao = () => new Set(cols.filter((c) => c && c.oculta).map(App.rotuloCol).filter(Boolean));
  try { const v = localStorage.getItem(k); return v === null ? padrao() : new Set(JSON.parse(v)); } catch (e) { return padrao(); }
};
App.gravarOcultas = (k, set) => { try { localStorage.setItem(k, JSON.stringify([...set])); } catch (e) { /* ok */ } };
App.colVisivel = (c, ocultas) => (c.controle ? c.controle.visivel !== false : !ocultas.has(App.rotuloCol(c)));
/** Botão "Colunas": lista com caixas para mostrar / ocultar. cols = colunas (já sem nulos); aoMudar() redesenha. */
App.botaoColunas = function (cols, ocultas, chave, aoMudar) {
  const opcoes = cols.map((c, i) => [c, i]).filter(([c, i]) => App.colOcultavel(c, i) || c.controle);
  const vistos = new Set();
  const unicas = opcoes.filter(([c]) => { const r = App.rotuloCol(c); if (vistos.has(r)) return false; vistos.add(r); return true; });
  if (unicas.length < 2) return null;
  const n = () => unicas.filter(([c]) => !App.colVisivel(c, ocultas)).length;
  const b = el("button", { class: "btn btn--linha btn--mini btn-colunas", type: "button", title: "Escolher quais colunas aparecem" });
  const rot = () => { b.textContent = n() ? `Colunas (${n()} oculta${n() > 1 ? "s" : ""})` : "Colunas"; };
  rot();
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const aberto = document.querySelector(".ajuda-pop--colunas");
    App.fecharAjuda();
    if (aberto && aberto._de === b) return;
    const lista = el("div", { class: "colunas-lista" }, unicas.map(([c]) => {
      const cx = el("input", { type: "checkbox", checked: App.colVisivel(c, ocultas) });
      cx.onchange = async () => {
        if (c.controle) { cx.disabled = true; const ok = await c.controle.mudar(cx.checked); if (ok === false) cx.checked = !cx.checked; cx.disabled = false; return; }
        cx.checked ? ocultas.delete(App.rotuloCol(c)) : ocultas.add(App.rotuloCol(c));
        App.gravarOcultas(chave, ocultas); rot(); aoMudar();
      };
      return el("label", { class: "colunas-item" }, cx, App.rotuloCol(c), c.controle && c.controle.nota ? el("small", {}, c.controle.nota) : null);
    }));
    const pop = el("div", { class: "ajuda-pop ajuda-pop--colunas", role: "dialog" },
      el("b", { class: "ajuda-pop__titulo" }, "Colunas da tabela"),
      el("p", { class: "ajuda", style: { margin: "0 0 8px" } }, "Desmarque para ocultar, marque para mostrar de novo. Nenhum dado é apagado."), lista,
      el("div", { class: "linha-acoes", style: { marginTop: "8px" } }, el("button", { class: "btn btn--mini btn--linha", type: "button", onclick: () => {
        unicas.forEach(([c]) => { if (!c.controle) ocultas.delete(App.rotuloCol(c)); }); App.gravarOcultas(chave, ocultas); rot(); App.fecharAjuda(); aoMudar();
      } }, "Mostrar todas")));
    pop._de = b;
    pop.addEventListener("click", (e) => e.stopPropagation());
    document.body.append(pop);
    const r = b.getBoundingClientRect(), w = Math.min(340, window.innerWidth - 24);
    pop.style.width = w + "px";
    pop.style.left = Math.max(12, Math.min(r.right + window.scrollX - w, window.scrollX + window.innerWidth - w - 12)) + "px";
    pop.style.top = (r.bottom + window.scrollY + 6) + "px";
  });
  return b;
};

App.tabela = function (colunas, linhas, { onClick = null, ordem = null, rodape = false, vazio = "Sem dados.", limite = 250, selecao = null, rodapeExtra = null,
  escolherColunas = true, ocultas: ocultasExt = null } = {}) {
  colunas = colunas.filter(Boolean);   // colunas opcionais podem vir como null
  const chaveCols = App.chaveColunas(colunas);
  const ocultas = ocultasExt || App.lerOcultas(chaveCols, colunas);
  let est = ordem || { i: -1, dir: 1 };
  let barra = null;
  if (selecao) {   // coluna de seleção + barra de ações em lote
    const sel = new Set();
    const limpar = () => { sel.clear(); desenhar(); barra.atualizar(); };
    barra = App.barraSelecao(sel, { nome: selecao.nome || "item(ns)", aoLimpar: () => desenhar(), acoes: [] });
    const acoes = selecao.acoes(() => [...sel], limpar);
    barra.querySelector(".barra-selecao__acoes").prepend(...acoes);
    const todos = () => linhas.length && linhas.every((l) => sel.has(selecao.id(l)));
    colunas = [{ rotulo: "", cabecalho: () => App.caixaSel(todos(), (v) => { linhas.forEach((l) => (v ? sel.add(selecao.id(l)) : sel.delete(selecao.id(l)))); desenhar(); barra.atualizar(); }, "Selecionar todos"),
      render: (l) => App.caixaSel(sel.has(selecao.id(l)), (v) => { v ? sel.add(selecao.id(l)) : sel.delete(selecao.id(l)); barra.atualizar(); }), classe: "col-sel" }, ...colunas];
  }
  if (selecao && est.i >= 0) est = { ...est, i: est.i + 1 };   // a coluna de seleção entra na frente
  let ordCol = est.i >= 0 ? colunas[est.i] : null, ordDir = est.dir || 1;   // ordem guardada pela coluna (as visíveis mudam)
  const todasCols = colunas;
  let mostrar = limite;   // listas grandes: desenha aos poucos (o total do rodapé considera todas as linhas)
  const mais = el("button", { class: "btn btn--linha btn--mini tabela-mais", hidden: true });
  const thead = el("thead");
  const tbody = el("tbody");
  const tfoot = el("tfoot");
  const tab = el("table", { class: "tabela" }, thead, tbody, tfoot);
  const desenhar = () => {
    colunas = todasCols.filter((c, i) => !App.colOcultavel(c, i) && !c.controle ? true : App.colVisivel(c, ocultas));
    App.limpar(thead).append(el("tr", {}, colunas.map((c) => {
      const th = el("th", { "data-ordem": c.valor ? "1" : null, class: (c.num ? "num " : "") + (c.classe ? c.classe + " " : "") + (ordCol === c ? (ordDir > 0 ? "asc" : "desc") : "") },
        c.cabecalho ? c.cabecalho() : c.rotulo, c.ajuda ? App.botaoAjuda(c.ajuda, typeof c.rotulo === "string" ? c.rotulo : "") : null);
      if (c.valor) th.onclick = () => { ordDir = ordCol === c ? -ordDir : (c.num ? -1 : 1); ordCol = c; desenhar(); };
      return th;
    })));
    let ls = [...linhas];
    if (ordCol && colunas.includes(ordCol) && ordCol.valor) {
      const f = ordCol.valor, dir = ordDir;
      ls.sort((a, b) => {
        const x = f(a), y = f(b);
        if (typeof x === "number" || typeof y === "number") return ((x ?? -Infinity) - (y ?? -Infinity)) * dir;
        return String(x ?? "").localeCompare(String(y ?? ""), "pt-BR") * dir;
      });
    }
    App.limpar(tbody);
    if (!ls.length) tbody.append(el("tr", {}, el("td", { colspan: colunas.length, class: "vazio" }, vazio)));
    for (const l of ls.slice(0, mostrar)) {
      const tr = el("tr", { class: onClick ? "clicavel" : "" }, colunas.map((c) => {
        const v = c.render ? c.render(l) : (c.valor ? c.valor(l) : "");
        return el("td", { class: (c.num ? "num " : "") + (c.classe || "") }, v);
      }));
      if (onClick) tr.onclick = (ev) => { if (!ev.target.closest("button, a, input, select")) onClick(l); };
      tbody.append(tr);
    }
    mais.hidden = ls.length <= mostrar;
    mais.textContent = `Mostrar mais ${Math.min(limite, ls.length - mostrar)} (de ${ls.length - mostrar} restantes)`;
    mais.onclick = () => { mostrar += limite; desenhar(); };
    App.limpar(tfoot);
    if (rodape && ls.length) tfoot.append(el("tr", {}, colunas.map((c) => el("td", { class: c.num ? "num" : "" }, c.total ? c.total(ls) : ""))));
    // linhas extras no rodapé: [{ rotulo, classe, celulas: { chave_da_coluna: conteúdo } }]
    if (rodapeExtra) rodapeExtra(ls).forEach((r) => {
      let rotuloPosto = false;
      tfoot.append(el("tr", { class: r.classe || "" }, colunas.map((c) => {
        let v = c.chave && r.celulas[c.chave] !== undefined ? r.celulas[c.chave] : "";
        if (!rotuloPosto && c.classe !== "col-sel") { rotuloPosto = true; v = r.rotulo; }
        return el("td", { class: c.num ? "num" : "" }, v);
      })));
    });
  };
  desenhar();
  const bCols = escolherColunas && !ocultasExt ? App.botaoColunas(todasCols, ocultas, chaveCols, desenhar) : null;
  return el("div", {}, barra, bCols ? el("div", { class: "tabela-ferr" }, bCols) : null, el("div", { class: "tabela-wrap" }, tab), mais);
};

/* ------------------------------------------------------------------ agregações */
App.soma = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);
App.agrupar = (arr, f) => arr.reduce((m, x) => { const k = f(x); (m[k] = m[k] || []).push(x); return m; }, {});
App.media = (arr, f) => (arr.length ? App.soma(arr, f) / arr.length : 0);

/* ------------------------------------------------------------------ modo edição */
App.atualizarCadeado = function () {
  const { editavel, local, admin } = App.meta;
  const b = document.getElementById("btn-cadeado"), selo = document.getElementById("selo-modo");
  selo.textContent = editavel ? (local ? "Edição (este computador)" : "Edição liberada") : "Somente visualização";
  selo.className = "selo-modo" + (editavel ? " selo-modo--editar" : "");
  // quem entrou vê a foto (leva ao perfil); visitante continua com o selo e o botão "Entrar na conta"
  selo.hidden = b.hidden = App.temPerfil();
  App.desenharAvatar();
  b.textContent = App.meta.visitante ? "Entrar na conta" : "Sair";
  b.title = App.meta.visitante ? "Entrar com sua conta da equipe para editar" : "Sair e voltar para a tela inicial";
  document.querySelectorAll("[data-editor]").forEach((x) => (x.hidden = !editavel));
  document.querySelectorAll("[data-admin]").forEach((x) => (x.hidden = !admin));
  App.atualizarMenu();
  document.querySelectorAll(".so-editor").forEach((x) => (editavel ? x.removeAttribute("data-bloqueado") : x.setAttribute("data-bloqueado", "")));
};

/** Módulos na ordem do menu (o servidor manda em ordem alfabética das chaves). */
App.guiasEmOrdem = (lista) => ["relatorio", "nf", "docs", "budget", "sup"].filter((g) => lista.includes(g));

/** Todos veem o Relatório de eventos; quem não tem a guia marcada na conta vê sem os botões de edição. */
App.ajustarEdicao = function (guia) {
  App.meta.editavel = App.meta.editavel_modulos && (guia !== "relatorio" || App.meta.edita_relatorio);
};

App.temPerfil = () => !App.meta.visitante && App.jaEntrou();
App.nomePerfil = () => (App.meta.usuario ? App.meta.usuario.nome : App.meta.entrou_local ? "PC do site" : "Edição por senha");

/** Foto de quem entrou; sem foto (ou se ela não abrir), as iniciais do nome. */
App.elFoto = function () {
  const iniciais = () => {
    const p = App.nomePerfil().trim().split(/\s+/);
    return el("span", { class: "avatar__iniciais" }, (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase());
  };
  if (!App.meta.foto) return iniciais();
  const img = el("img", { src: App.meta.foto, alt: "", width: 256, height: 256 });
  img.onerror = () => img.replaceWith(iniciais());
  return img;
};

App.desenharAvatar = function () {
  const a = document.getElementById("btn-perfil"), n = App.meta.admin ? App.meta.pendentes || 0 : 0;
  a.hidden = !App.temPerfil();
  if (a.hidden) return;
  const rotulo = `Abrir meu perfil (${App.nomePerfil()})` + (n ? `: ${n} solicitação(ões) pendente(s)` : "");
  a.setAttribute("aria-label", rotulo);
  a.title = rotulo;
  App.limpar(a).append(App.elFoto(), n ? el("span", { class: "abas__badge avatar__badge" }, String(n)) : "");
};

App.atualizarPendentes = async function () {
  if (!App.meta || !App.meta.admin || document.hidden) return;
  try {
    App.meta.pendentes = (await App.api("/api/solicitacoes/pendentes")).pendentes;
    App.desenharAvatar();
  } catch (e) { /* tenta de novo no próximo ciclo */ }
};

/** Menu: mostra só as abas da área atual (Relatório de eventos ou Notas fiscais) que a pessoa pode ver.
 *  Quem tem as duas áreas ganha o seletor de área no começo do menu. */
App.areaAtual = "relatorio";
App.atualizarMenu = function (rota, sub) {
  const m = App.meta || {};
  const guias = (m.acessos || []).length ? m.acessos : ["relatorio"];
  if (rota) App.areaAtual = ["nf", "docs", "budget", "sup"].includes(rota) ? rota : rota === "perfil" ? App.areaAtual : "relatorio";
  if (!guias.includes(App.areaAtual)) App.areaAtual = guias[0];
  const area = App.areaAtual;
  const areas = document.getElementById("areas");
  areas.querySelectorAll("a").forEach((a) => { a.classList.toggle("ativa", a.dataset.areaBtn === area); a.hidden = !guias.includes(a.dataset.areaBtn); });
  const nomeArea = areas.querySelector(`a[data-area-btn="${area}"] b`);
  document.getElementById("area-nome").textContent = rota === "perfil" ? "Meu perfil" : (nomeArea ? nomeArea.firstChild.textContent.trim() : "");
  if (rota !== undefined) App._rotaMenu = rota;
  document.querySelectorAll("#abas > a[data-guia]").forEach((a) => {
    a.hidden = App._rotaMenu === "perfil" || a.dataset.guia !== area || !guias.includes(a.dataset.guia) || (a.hasAttribute("data-editor") && !m.editavel) || (a.hasAttribute("data-so-visitante") && !m.visitante);
  });
  if (rota !== undefined) {
    document.querySelectorAll("#abas > a[data-rota]").forEach((a) =>
      a.classList.toggle("ativa", a.dataset.rota === rota && (!a.dataset.sub || a.dataset.sub === (sub || { nf: "medicoes", docs: "lista", budget: "budget", sup: "mes" }[rota]))));
  }
  try { localStorage.setItem("rge_area", area); } catch (e) { /* ok */ }
};

/* Menu lateral (gaveta) com as áreas do site */
App.gaveta = (abrir) => {
  const g = document.getElementById("gaveta");
  g.hidden = !abrir;
  document.getElementById("btn-menu").setAttribute("aria-expanded", String(abrir));
  document.body.classList.toggle("gaveta-aberta", abrir);
  if (abrir) (g.querySelector("a.ativa:not([hidden])") || g.querySelector("a:not([hidden])"))?.focus();
};
document.addEventListener("click", (e) => {
  if (e.target.closest("#btn-menu")) App.gaveta(document.getElementById("gaveta").hidden);
  else if (e.target.closest("[data-fechar-gaveta]")) {
    App.gaveta(false); document.getElementById("btn-menu").focus();
    if (e.target.closest("[data-ajuda-teclado]")) App.ajudaTeclado();
  }
  else if (e.target.closest("#gaveta a")) App.gaveta(false);
});

/* ------------------------------------------------------------------ navegação por teclado */
const FOCAVEIS = "a[href]:not([hidden]), button:not([disabled]):not([hidden]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
const visivel = (n) => !!(n.offsetWidth || n.offsetHeight || n.getClientRects().length) && !n.closest("[hidden]");
const focaveisEm = (raiz) => [...raiz.querySelectorAll(FOCAVEIS)].filter(visivel);
const digitando = (t) => t && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName));

/** Mantém o Tab dentro da janela aberta (modal ou menu lateral). */
const prenderTab = (e, raiz) => {
  const fs = focaveisEm(raiz);
  if (!fs.length) { e.preventDefault(); return; }
  const i = fs.indexOf(document.activeElement);
  if (e.shiftKey && (i <= 0)) { e.preventDefault(); fs[fs.length - 1].focus(); }
  else if (!e.shiftKey && (i === -1 || i === fs.length - 1)) { e.preventDefault(); fs[0].focus(); }
};

/** Botão principal da janela (Salvar, Importar, Criar…) para o atalho Ctrl+Enter. */
const botaoPrincipal = (raiz) => [...raiz.querySelectorAll(".linha-acoes .btn, .modal-acoes .btn")]
  .find((b) => visivel(b) && !b.disabled && !b.matches(".btn--linha, .btn--perigo, .btn--fantasma, [data-fechar]"));

document.addEventListener("keydown", (e) => {
  const t = e.target;
  const modal = document.getElementById("modal"), gav = document.getElementById("gaveta");
  const modalAberto = !modal.hidden, gavAberta = !gav.hidden;

  if (e.key === "Escape") {
    const menu = document.querySelector(".menu-exportar:not([hidden])");
    if (menu) { menu.hidden = true; menu.parentElement.querySelector("button")?.focus(); return; }
    if (modalAberto) {
      const aviso = modal.querySelector(".modal__aviso");
      if (aviso) { aviso.querySelector("button").click(); return; }   // Esc no aviso = continuar editando
      App.pedirFecharModal(); return;
    }
    if (gavAberta) { App.gaveta(false); document.getElementById("btn-menu").focus(); }
    return;
  }
  if (e.key === "Tab") {
    if (modalAberto) prenderTab(e, modal.querySelector(".modal__caixa"));
    else if (gavAberta) prenderTab(e, gav.querySelector(".gaveta__painel"));
    return;
  }
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && modalAberto) {
    const b = botaoPrincipal(modal);
    if (b) { e.preventDefault(); b.click(); }
    return;
  }
  // Enter / Espaço em linhas, cabeçalhos e cartões clicáveis
  if ((e.key === "Enter" || e.key === " ") && t.dataset?.tecla && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault(); t.click(); return;
  }
  // setas: sobe/desce entre as linhas de uma tabela; esquerda/direita entre as abas
  if ((e.key === "ArrowDown" || e.key === "ArrowUp") && t.tagName === "TR" && t.dataset.tecla) {
    const linhas = [...t.parentElement.children].filter((r) => r.dataset.tecla && visivel(r));
    const n = linhas[linhas.indexOf(t) + (e.key === "ArrowDown" ? 1 : -1)];
    if (n) { e.preventDefault(); n.focus(); }
    return;
  }
  if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && t.closest?.("#abas") && t.tagName === "A") {
    const abas = [...document.querySelectorAll("#abas > a")].filter(visivel);
    const n = abas[abas.indexOf(t) + (e.key === "ArrowRight" ? 1 : -1)];
    if (n) { e.preventDefault(); n.focus(); }
    return;
  }
  if ((e.key === "ArrowDown" || e.key === "ArrowUp") && t.closest?.(".menu-exportar, #areas")) {
    const itens = focaveisEm(t.closest(".menu-exportar, #areas"));
    const n = itens[itens.indexOf(t) + (e.key === "ArrowDown" ? 1 : -1)];
    if (n) { e.preventDefault(); n.focus(); }
    return;
  }
  // atalhos gerais (fora de campos de texto e sem janela aberta)
  if (digitando(t) || modalAberto || e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.key === "/") {
    const b = [...document.querySelectorAll("#app input[type=search]")].find(visivel);
    if (b) { e.preventDefault(); b.focus(); b.select(); }
  } else if (e.key === "?") {
    e.preventDefault(); App.ajudaTeclado();
  } else if ((e.key === "m" || e.key === "M") && !gavAberta) {
    e.preventDefault(); App.gaveta(true);
  }
});

App.ajudaTeclado = () => {
  const linha = (teclas, oque) => el("tr", {}, el("td", {}, ...teclas.map((k, i) => [i ? " " : null, el("kbd", {}, k)])), el("td", {}, oque));
  App.modal(el("div", { class: "modal--largo" }, el("h3", {}, "Atalhos do teclado"),
    el("table", { class: "tabela-atalhos" }, el("tbody", {},
      linha(["Tab"], "vai para o próximo botão, campo, link ou linha da tabela (Shift + Tab volta)"),
      linha(["Enter"], "abre / aciona o item em foco (linha da tabela, cabeçalho para ordenar, cartão)"),
      linha(["↑", "↓"], "sobe e desce entre as linhas de uma tabela e entre os itens de um menu"),
      linha(["←", "→"], "passa de uma aba para outra na barra de abas"),
      linha(["M"], "abre o menu de áreas"),
      linha(["/"], "vai direto para a busca da tela"),
      linha(["Ctrl", "Enter"], "dentro de uma janela de cadastro ou edição: salva (botão principal)"),
      linha(["Esc"], "fecha a janela ou o menu; se já houver algo preenchido, pergunta antes de descartar"),
      linha(["?"], "mostra esta lista"))),
    el("div", { class: "linha-acoes" }, el("button", { class: "btn", "data-fechar": "" }, "Entendi"))));
};

/* Pular direto para o conteúdo (primeiro Tab da página) */
(() => {
  const main = document.getElementById("app");
  main.tabIndex = -1;
  const pular = el("a", { class: "pular", href: "#app" }, "Pular para o conteúdo");
  pular.addEventListener("click", (e) => { e.preventDefault(); (main.querySelector("h2, h1") || main).setAttribute("tabindex", "-1"); (main.querySelector("h2, h1") || main).focus(); });
  document.body.prepend(pular);
})();

App.alternarEdicao = async function () {
  const eraVisitante = App.meta.visitante;
  try { await App.api("/api/logout", { method: "POST" }); } catch (e) { /* ok */ }
  App.meta = await App.api("/api/meta");
  // a página anterior não fica para trás da tela inicial; o tema de jogo também não (rotear refaz os dois ao entrar)
  App.destruirGraficos();
  App.limpar(document.getElementById("app"));
  App.aplicarTema(false);
  if (location.hash.startsWith("#/perfil")) history.replaceState(null, "", "#/visao");   // quem entrar depois começa pelo início
  await App.telaEntrada(eraVisitante ? "login" : null);
  App.atualizarCadeado();
  if ((App.meta.acessos || []).includes("docs") && App.docs) App.docs.carregar().catch(() => {});
  await App.carregarEventos();
  App.rotear();
};

App.semMovimento = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } };

/** Já escolheu como acessar (visitante ou conta) nesta sessão do navegador? */
App.jaEntrou = () => !!(App.meta.login_logado || App.meta.visitante || App.meta.entrou_local);

/** Tela inicial: Visitante (só visualização) ou Entrar na conta. Resolve quando a pessoa entra. */
App.telaEntrada = (modoInicial = null) => new Promise((resolve) => {
  const m = App.meta;
  const svg = (d) => { const x = document.createElementNS("http://www.w3.org/2000/svg", "svg"); x.setAttribute("viewBox", "0 0 24 24"); x.setAttribute("aria-hidden", "true"); x.innerHTML = d; return x; };
  const icOlho = '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>';
  const icChave = '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>';
  const barras = () => {
    const x = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    x.setAttribute("viewBox", "0 0 190 120"); x.setAttribute("preserveAspectRatio", "none"); x.setAttribute("class", "entrada__barras"); x.setAttribute("aria-hidden", "true");
    x.innerHTML = document.querySelector(".topo__barras")?.innerHTML || "";
    return x;
  };
  const fechar = async () => {
    App.meta = await App.api("/api/meta");
    tela.classList.add("saindo");
    fundo.forEach((x) => x && x.removeAttribute("inert"));
    setTimeout(() => { tela.remove(); document.body.classList.remove("com-entrada"); }, 220);
    resolve();
  };

  /* ---- botões de escolha */
  const btnVisitante = el("button", { class: "entrada__opcao", type: "button" },
    el("span", { class: "entrada__icone" }, svg(icOlho)),
    el("span", {}, el("b", {}, "Visitante"), el("small", {}, "Ver relatórios, gráficos e baixar as planilhas anexadas. Nada pode ser alterado.")));
  const btnConta = el("button", { class: "entrada__opcao entrada__opcao--principal", type: "button" },
    el("span", { class: "entrada__icone" }, svg(icChave)),
    el("span", {}, el("b", {}, "Entrar na conta"), el("small", {}, "Equipe de Engenharia: cadastrar eventos, anexar planilhas e editar dados.")));
  const btnPedir = el("button", { class: "entrada__opcao", type: "button" },
    el("span", { class: "entrada__icone" }, svg('<circle cx="10" cy="8" r="4"/><path d="M3 21a7 7 0 0 1 12.5-4.3M18 14v6M15 17h6"/>')),
    el("span", {}, el("b", {}, "Solicitar acesso"), el("small", {}, "Ainda não tem conta? Peça ao administrador.")));
  const escolha = el("div", { class: "entrada__escolha" },
    el("h2", {}, "Como você quer acessar?"),
    el("p", { class: "entrada__sub" }, "Escolha uma opção para continuar."),
    btnVisitante, btnConta, btnPedir);

  /* ---- formulário de login */
  const comContas = m.tem_contas;
  const u = el("input", { type: "text", name: "usuario", autocomplete: "username", autocapitalize: "off", spellcheck: "false", placeholder: "seu usuário…" });
  const s = el("input", { type: "password", name: "senha", autocomplete: "current-password", placeholder: "sua senha…" });
  const msg = el("p", { class: "entrada__erro", role: "alert" });
  const btnEntrar = el("button", { class: "btn entrada__entrar", type: "submit" }, "Entrar");
  const btnLocal = m.local ? el("button", { class: "btn btn--linha entrada__entrar", type: "button" }, "Entrar como administrador deste computador") : null;
  const semAcesso = !comContas && !m.senha_unica && !m.local;
  const form = el("form", { class: "entrada__form", hidden: true },
    el("button", { class: "entrada__voltar", type: "button", onclick: () => mostrar("escolha") }, "← Voltar"),
    el("h2", {}, "Entrar na conta"),
    el("p", { class: "entrada__sub" }, semAcesso ? "Ainda não há contas cadastradas. Peça ao administrador do site para criar a sua."
      : comContas ? "Use o usuário e a senha que o administrador criou para você." : m.senha_unica ? "Digite a senha de edição." : "Este computador é o servidor do site."),
    comContas ? el("label", { class: "campo" }, el("span", {}, "Usuário"), u) : null,
    comContas || m.senha_unica ? el("label", { class: "campo" }, el("span", {}, "Senha"), s) : null,
    msg,
    comContas || m.senha_unica ? btnEntrar : null,
    btnLocal,
    m.local ? el("p", { class: "entrada__nota" }, "Você está no computador onde o site roda: aqui dá para entrar direto como administrador.") : null,
    el("button", { class: "entrada__voltar", type: "button", onclick: () => mostrar("pedido") }, "Não tem conta? Solicitar acesso"));

  /* ---- pedido de login: o administrador recebe no perfil */
  const pNome = el("input", { type: "text", name: "nome", autocomplete: "name", maxlength: 120, placeholder: "seu nome…" });
  const pContato = el("input", { type: "text", name: "contato", autocomplete: "email", maxlength: 120, placeholder: "e-mail ou telefone…" });
  const pMotivo = el("textarea", { name: "motivo", rows: 2, maxlength: 500, placeholder: "para que você precisa do acesso…" });
  const pModulos = App.guiasEmOrdem(Object.keys(m.guias || {})).map((g) => {
    const c = el("input", { type: "checkbox", value: g });
    return { c, linha: el("label", {}, c, el("span", {}, m.guias[g])) };
  });
  const pMsg = el("p", { class: "entrada__erro", role: "alert" });
  const pBtn = el("button", { class: "btn entrada__entrar", type: "submit" }, "Enviar pedido");
  const pCampos = el("div", {},
    el("p", { class: "entrada__sub" }, "O administrador recebe o pedido e passa o usuário e a senha para você."),
    App.progressoForm([{ rotulo: "nome", ok: () => !!pNome.value.trim() }, { rotulo: "contato", ok: () => !!pContato.value.trim() },
      { rotulo: "módulo", ok: () => pModulos.some((x) => x.c.checked) }]),
    el("label", { class: "campo" }, el("span", {}, "Nome"), pNome),
    el("label", { class: "campo" }, el("span", {}, "Contato"), pContato),
    el("div", { class: "campo" }, el("span", {}, "Módulos"), el("div", { class: "acessos-lista" }, pModulos.map((x) => x.linha))),
    el("label", { class: "campo" }, el("span", {}, "Motivo (opcional)"), pMotivo),
    pMsg, pBtn);
  const pFim = el("div", { hidden: true }, el("div", { class: "entrada__sucesso", role: "status" }, el("b", {}, "✓ Pedido enviado"),
    el("p", { class: "entrada__sub" }, "O administrador recebe o aviso e fala com você pelo contato informado. Enquanto isso, você já pode ver os relatórios como visitante.")));
  const pedido = el("form", { class: "entrada__form", hidden: true },
    el("button", { class: "entrada__voltar", type: "button", onclick: () => mostrar("escolha") }, "← Voltar"),
    el("h2", {}, "Solicitar acesso"), pCampos, pFim);
  pedido.onsubmit = async (ev) => {
    ev.preventDefault();
    pBtn.disabled = true; pMsg.textContent = "";
    try {
      await App.api("/api/solicitacoes/login", { method: "POST", json: { nome: pNome.value, contato: pContato.value, motivo: pMotivo.value, modulos: pModulos.filter((x) => x.c.checked).map((x) => x.c.value) } });
      pCampos.hidden = true; pFim.hidden = false;
    } catch (e) { pMsg.textContent = e.message; }
    pBtn.disabled = false;
  };
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    btnEntrar.disabled = true; msg.textContent = "";
    try {
      const r = await App.api("/api/login", { method: "POST", json: { login: comContas ? u.value : "", senha: s.value } });
      App.toast(r.nome ? `Olá, ${r.nome}! Edição liberada.` : "Edição liberada.");
      await fechar();
    } catch (e) { msg.textContent = e.message; s.select(); }
    btnEntrar.disabled = false;
  };
  if (btnLocal) btnLocal.onclick = async () => { await App.api("/api/entrar-local", { method: "POST" }); App.toast("Entrou como administrador deste computador."); await fechar(); };
  btnVisitante.onclick = async () => { await App.api("/api/visitante", { method: "POST" }); await fechar(); };
  btnConta.onclick = () => mostrar("login");
  btnPedir.onclick = () => mostrar("pedido");

  const mostrar = (qual) => {
    escolha.hidden = qual !== "escolha";
    form.hidden = qual !== "login";
    pedido.hidden = qual !== "pedido";
    msg.textContent = "";
    if (qual === "login") setTimeout(() => (comContas ? u : (m.senha_unica ? s : btnLocal))?.focus(), 30);
    if (qual === "pedido") setTimeout(() => pNome.focus(), 30);
  };

  /* ---- landing page: o que é a Central, módulos, destaques e dúvidas (o acesso fica no topo, ao lado do título) */
  const ic = {
    eventos: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    manut: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>',
    nf: '<path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6M9 13h8M9 17h6"/>',
    budget: '<circle cx="12" cy="12" r="9"/><path d="M12 3v9l6.4 6.4"/>',
    sup: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    docs: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="m8 12 3 3 5-6"/>',
  };
  const irPara = (id) => (ev) => { ev.preventDefault(); const alvo = tela.querySelector("#" + id); if (alvo) { alvo.scrollIntoView({ behavior: App.semMovimento() ? "auto" : "smooth" }); alvo.focus({ preventScroll: true }); } };
  const irAcesso = (modo) => () => { mostrar(modo); tela.querySelector("#lp-acesso").scrollIntoView({ behavior: App.semMovimento() ? "auto" : "smooth", block: "center" }); };
  const modulos = [
    ["eventos", "Relatório de eventos", "Custo de cada show, jogo e projeto especial: mão de obra, avarias, insumos e medidores de consumo."],
    ["manut", "Manutenção", "Chamados por evento, tempo de atendimento e quanto ficou dentro do prazo de 60 minutos."],
    ["nf", "Notas fiscais e contratos", "Medições, saldo de cada contrato, prazos das notas e alertas de vencimento."],
    ["budget", "Budget", "Solicitado, aprovado e incorrido por projeto, centro de custo e classe financeira."],
    ["sup", "Suprimentos", "Rateio das contas de energia, água, gás e poço entre locatários, eventos e Engenharia."],
    ["docs", "Documentos", "Licenças e laudos da arena com aviso antes de vencer."],
  ];
  const faq = [
    ["Quem pode acessar?", "Qualquer pessoa com o link entra como visitante e vê relatórios e gráficos, sem alterar nada. Para cadastrar e editar, é preciso uma conta da equipe de Engenharia."],
    ["Preciso instalar alguma coisa?", "Não. A Central abre no navegador do computador ou do celular."],
    ["Os dados são confidenciais?", "Sim. É uma ferramenta de uso interno: não compartilhe o link fora da empresa nem tire prints de valores de contrato."],
    ["Como peço uma conta?", "Clique em Solicitar acesso, no início desta página, e informe seu nome, um contato e os módulos que precisa. O administrador recebe o pedido, cria o seu usuário e define o que você pode ver e editar."],
    ["Encontrei um número estranho. E agora?", "Use o botão ? do gráfico ou da coluna para ver como o valor é calculado. Se ainda parecer errado, avise o administrador com a tela e o mês."],
  ];
  const sec = (id, titulo, sub, ...filhos) => el("section", { class: "lp-sec", id, tabindex: "-1", "aria-labelledby": id + "-t" },
    el("div", { class: "lp-sec__cab" }, el("h2", { id: id + "-t" }, titulo), sub ? el("p", {}, sub) : null), ...filhos);

  const tela = el("div", { class: "entrada" },
    el("a", { class: "lp-pular", href: "#lp-acesso", onclick: irPara("lp-acesso") }, "Pular para o acesso"),
    el("header", { class: "lp-topo" },
      el("span", { class: "lp-topo__marca" }, el("b", {}, m.titulo || "Central de Engenharia"), el("span", {}, m.setor || "Engenharia & Infraestrutura")),
      el("nav", { class: "lp-topo__nav", "aria-label": "Seções da página" },
        el("a", { href: "#lp-modulos", onclick: irPara("lp-modulos") }, "Módulos"),
        el("a", { href: "#lp-faq", onclick: irPara("lp-faq") }, "Dúvidas")),
      el("button", { class: "btn lp-topo__entrar", type: "button", onclick: irAcesso("login") }, "Entrar")),
    el("main", { class: "lp", id: "lp-conteudo" },
      el("div", { class: "lp-hero" },
        el("section", { class: "entrada__marca", "aria-labelledby": "lp-titulo" },
          el("div", { class: "entrada__marca-texto" },
            el("span", { class: "antetitulo" }, `Arena Demo · ${m.setor || "Engenharia & Infraestrutura"}`),
            el("h1", { id: "lp-titulo" }, "Os números da Engenharia em um só lugar"),
            el("p", {}, "Custos de eventos, contratos, budget e contas de consumo atualizados, com gráficos prontos e Excel com fórmulas em um clique.")),
          barras()),
        el("section", { class: "entrada__painel", id: "lp-acesso", tabindex: "-1", "aria-label": "Acesso à Central" },
          el("div", { class: "entrada__caixa" }, escolha, form, pedido))),
      sec("lp-modulos", "Módulos", "Seis áreas que conversam entre si: a conta de consumo do Suprimentos, por exemplo, já entra no Budget.",
        el("ul", { class: "lp-modulos" }, modulos.map(([k, t, d]) => el("li", { class: "lp-card" },
          el("span", { class: "entrada__icone" }, svg(ic[k])), el("h3", {}, t), el("p", {}, d))))),
      sec("lp-destaques", "Feito para o dia a dia", null,
        el("ul", { class: "lp-destaques" }, [
          ["Navegador e celular", "Nada para instalar; funciona no computador e no telefone."],
          ["Excel com fórmulas", "As planilhas exportadas recalculam sozinhas quando você muda um valor."],
          ["Cada número explicado", "O botão ? diz o que o card ou a coluna calcula e por quê."],
          ["Quem mudou o quê", "Contas por pessoa e histórico de alterações."],
        ].map(([t, d]) => el("li", {}, el("b", {}, t), el("span", {}, d))))),
      sec("lp-faq", "Dúvidas frequentes", null,
        el("div", { class: "lp-faq" }, faq.map(([q, r]) => el("details", {}, el("summary", {}, q), el("p", {}, r)))))),
    el("footer", { class: "lp-rodape" },
      el("span", {}, `${m.setor || "Engenharia & Infraestrutura"} · Arena Demo`), el("span", {}, "Uso interno")));
  // enquanto a página inicial está aberta, o site por trás não recebe foco nem leitor de tela
  const fundo = [document.querySelector("a.pular"), document.querySelector(".topo"), document.querySelector(".abas"), document.getElementById("app"), document.getElementById("gaveta")];
  fundo.forEach((x) => x && x.setAttribute("inert", ""));
  document.body.classList.add("com-entrada");
  document.body.append(tela);
  mostrar(modoInicial === "login" ? "login" : "escolha");
});

/** Janela de login: usuário + senha (contas da equipe). Resolve true se entrou. */
App.formLogin = () => new Promise((res) => {
  const comContas = App.meta.tem_contas;
  const u = el("input", { type: "text", autocomplete: "username", placeholder: "seu usuário", style: { width: "100%" } });
  const s = el("input", { type: "password", autocomplete: "current-password", placeholder: "senha", style: { width: "100%" } });
  const msg = el("p", { class: "ajuda", style: { color: "var(--perigo)", minHeight: "18px" } });
  const entrar = async () => {
    try {
      const r = await App.api("/api/login", { method: "POST", json: { login: comContas ? u.value : "", senha: s.value } });
      App.fecharModal();
      App.toast(r.nome ? `Olá, ${r.nome}! Edição liberada.` : "Edição liberada.");
      res(true);
    } catch (e) { msg.textContent = e.message; s.select(); }
  };
  [u, s].forEach((x) => x.addEventListener("keydown", (e) => e.key === "Enter" && entrar()));
  App.modal(el("div", {}, el("h3", {}, "Entrar para editar"),
    el("p", { class: "ajuda", style: { marginTop: 0 } }, comContas ? "Use a conta que o administrador criou para você." : "Digite a senha de edição."),
    comContas ? el("label", { class: "campo", style: { marginBottom: "10px" } }, el("span", {}, "Usuário"), u) : null,
    el("label", { class: "campo" }, el("span", {}, "Senha"), s), msg,
    el("div", { class: "linha-acoes" }, el("button", { class: "btn", onclick: entrar }, "Entrar"),
      el("button", { class: "btn btn--linha", onclick: () => { App.fecharModal(); res(false); } }, "Cancelar"))));
  setTimeout(() => (comContas ? u : s).focus(), 50);
});

App.trocarMinhaSenha = function () {
  const atual = el("input", { type: "password", autocomplete: "current-password", style: { width: "100%" } });
  const nova = el("input", { type: "password", autocomplete: "new-password", style: { width: "100%" } });
  const conf = el("input", { type: "password", autocomplete: "new-password", style: { width: "100%" } });
  const msg = el("p", { class: "ajuda", style: { color: "var(--perigo)", minHeight: "18px" } });
  App.modal(el("div", {}, el("h3", {}, "Trocar minha senha"),
    el("div", { class: "grade", style: { gap: "10px" } },
      el("label", { class: "campo" }, el("span", {}, "Senha atual"), atual),
      el("label", { class: "campo" }, el("span", {}, "Nova senha (mín. 8 caracteres)"), nova),
      el("label", { class: "campo" }, el("span", {}, "Repita a nova senha"), conf)), msg,
    el("div", { class: "linha-acoes" }, el("button", {
      class: "btn", onclick: async () => {
        if (nova.value !== conf.value) { msg.textContent = "As senhas novas não são iguais."; return; }
        try {
          await App.api("/api/minha-senha", { method: "POST", json: { atual: atual.value, nova: nova.value } });
          App.fecharModal(); App.toast("Senha alterada.");
        } catch (e) { msg.textContent = e.message; }
      },
    }, "Salvar"), el("button", { class: "btn btn--linha", "data-fechar": "" }, "Cancelar"))));
};

/* Botão visível só para quem pode editar */
App.btnEditor = (rotulo, onclick, classe = "btn") => {
  const b = el("button", { class: classe + " so-editor", onclick }, rotulo);
  if (!App.meta.editavel) b.setAttribute("data-bloqueado", "");
  return b;
};

/* ------------------------------------------------------------------ tabela com linhas que expandem */
/** colunas: como em App.tabela · grupos: linhas principais · filhos(g) -> linhas · colunasFilhos */
App.tabelaExpansivel = function (colunas, grupos, { filhos, colunasFilhos, ordem = null, vazio = "Sem dados.", rodape = true, semLimite = false }) {
  colunas = colunas.filter(Boolean);
  // escolha de colunas única para a tabela e as linhas abertas (mesmo nome = mesma coluna)
  const todasCols = colunas, juntas = [...colunas, ...(colunasFilhos || []).filter((c, i) => i > 0)];
  const chaveCols = App.chaveColunas(juntas);
  const ocultas = App.lerOcultas(chaveCols, juntas);
  let est = ordem || { i: -1, dir: 1 };
  let ordCol = est.i >= 0 ? colunas[est.i] : null, ordDir = est.dir || 1;
  const abertos = new Set();
  const chave = (g) => g.chave ?? JSON.stringify(g);
  const thead = el("thead"), tbody = el("tbody"), tfoot = el("tfoot");
  const tab = el("table", { class: "tabela tabela--exp" }, thead, tbody, tfoot);
  const desenhar = () => {
    colunas = todasCols.filter((c, i) => (!App.colOcultavel(c, i) && !c.controle) || App.colVisivel(c, ocultas));
    App.limpar(thead).append(el("tr", {}, el("th", { style: { width: "34px" } }), colunas.map((c) => {
      const th = el("th", { "data-ordem": c.valor ? "1" : null, class: (c.num ? "num " : "") + (ordCol === c ? (ordDir > 0 ? "asc" : "desc") : "") },
        c.rotulo, c.ajuda ? App.botaoAjuda(c.ajuda, typeof c.rotulo === "string" ? c.rotulo : "") : null);
      if (c.valor) th.onclick = () => { ordDir = ordCol === c ? -ordDir : (c.num ? -1 : 1); ordCol = c; desenhar(); };
      return th;
    })));
    let ls = [...grupos];
    if (ordCol && colunas.includes(ordCol) && ordCol.valor) {
      const f = ordCol.valor, dir = ordDir;
      ls.sort((a, b) => {
        const x = f(a), y = f(b);
        if (typeof x === "number" || typeof y === "number") return ((x ?? -Infinity) - (y ?? -Infinity)) * dir;
        return String(x ?? "").localeCompare(String(y ?? ""), "pt-BR") * dir;
      });
    }
    App.limpar(tbody);
    if (!ls.length) tbody.append(el("tr", {}, el("td", { colspan: colunas.length + 1, class: "vazio" }, vazio)));
    for (const g of ls) {
      const k = chave(g), aberto = abertos.has(k);
      const tr = el("tr", { class: "grupo" + (aberto ? " aberto" : ""), "aria-expanded": String(aberto) },
        el("td", {}, el("span", { class: "seta" }, "▸")),
        colunas.map((c) => el("td", { class: c.num ? "num" : "" }, c.render ? c.render(g) : (c.valor ? c.valor(g) : ""))));
      tr.onclick = (ev) => {
        if (ev.target.closest("a, button")) return;
        aberto ? abertos.delete(k) : abertos.add(k);
        desenhar();
      };
      tbody.append(tr);
      if (aberto) {
        tbody.append(el("tr", { class: "filhos" }, el("td", {}), el("td", { colspan: colunas.length },
          App.tabela(colunasFilhos.filter((c, i) => i === 0 || App.colVisivel(c, ocultas)), filhos(g), { rodape: true, escolherColunas: false, ...(semLimite ? { limite: 100000 } : {}) }))));
      }
    }
    App.limpar(tfoot);
    if (rodape && ls.length) tfoot.append(el("tr", {}, el("td"), colunas.map((c) => el("td", { class: c.num ? "num" : "" }, c.total ? c.total(ls) : ""))));
  };
  desenhar();
  const btnAbrir = el("button", { class: "btn btn--linha btn--mini" }, "Expandir tudo");
  const btnFechar = el("button", { class: "btn btn--linha btn--mini" }, "Recolher tudo");
  btnAbrir.onclick = () => { grupos.forEach((g) => abertos.add(chave(g))); desenhar(); };
  btnFechar.onclick = () => { abertos.clear(); desenhar(); };
  const bCols = App.botaoColunas(juntas, ocultas, chaveCols, desenhar);
  if (bCols) bCols.style.marginLeft = "auto";
  return el("div", {}, el("div", { class: "linha-acoes", style: { marginTop: 0, marginBottom: "10px" } }, btnAbrir, btnFechar, bCols),
    el("div", { class: "tabela-wrap " + (semLimite ? "tabela-wrap--cheia" : "tabela-wrap--alta") }, tab));
};


/* ------------------------------------------------------------------ envio de arquivos (um por vez, com mensagens claras) */
App.enviarArquivos = async function (url, files, extras = {}) {
  const resultados = [];
  const lista = [...files];
  for (let i = 0; i < lista.length; i++) {
    const f = lista[i];
    if (lista.length > 1) App.toast(`Enviando ${i + 1} de ${lista.length}: ${f.name}`);
    let conteudo;
    try {
      conteudo = new Blob([await f.arrayBuffer()], { type: f.type });   // lê antes: evita erro se o arquivo mudar/estiver travado
    } catch (e) {
      resultados.push({ arquivo: f.name, erro: "Não consegui ler o arquivo. Feche-o no Excel (ou espere a sincronização terminar) e tente de novo." });
      continue;
    }
    const fd = new FormData();
    fd.append("arquivo", conteudo, f.name);
    Object.entries(extras).forEach(([k, v]) => fd.append(k, v));
    try {
      const r = await fetch(url, { method: "POST", body: fd });
      const tipo = r.headers.get("content-type") || "";
      const dados = tipo.includes("json") ? await r.json() : null;
      if (!r.ok) { resultados.push({ arquivo: f.name, erro: (dados && dados.erro) || `Erro ${r.status} no servidor.` }); continue; }
      resultados.push(...(dados.resultados || [dados]));
    } catch (e) {
      resultados.push({ arquivo: f.name, erro: "O servidor não respondeu. Confira se a janela do site (terminal) está aberta e tente de novo." });
    }
  }
  return resultados;
};

/** quebra rótulos longos em várias linhas (o Chart.js aceita array de linhas) */
App.quebrar = function (t, max = 30) {
  const linhas = [""];
  for (const p of String(t).split(" ")) {
    if ((linhas[linhas.length - 1] + " " + p).trim().length > max) linhas.push(p);
    else linhas[linhas.length - 1] = (linhas[linhas.length - 1] + " " + p).trim();
  }
  return linhas.length > 1 ? linhas : linhas[0];
};

/* ------------------------------------------------------------------ arrastar e soltar arquivos */
/** Todo campo de arquivo visível (janelas de importar, anexar NF, documentos…) vira uma área onde dá para
    arrastar o arquivo da pasta ou clicar para escolher. Campos escondidos (botões "Importar Excel") usam o
    arrastar na página inteira (App.soltarNaPagina). */
App.realcarArquivos = function () {
  const realcar = (inp) => {
    if (inp.dataset.zona || inp.hidden || inp.closest(".zona-arquivo") || inp.closest(".soltar")) return;
    inp.dataset.zona = "1";
    const nome = el("span", { class: "zona-arquivo__nome" });
    const zona = el("div", { class: "zona-arquivo", role: "button", tabindex: "0" },
      el("span", { class: "zona-arquivo__texto" }, el("b", {}, inp.multiple ? "Arraste os arquivos aqui" : "Arraste o arquivo aqui"), " ou clique para escolher"),
      nome);
    const mostrar = () => { const n = [...(inp.files || [])].map((f) => f.name); nome.textContent = n.join(", "); zona.classList.toggle("com-arquivo", !!n.length); };
    inp.parentNode.insertBefore(zona, inp);
    zona.prepend(inp);
    inp.addEventListener("change", mostrar);
    inp.tabIndex = -1;
    zona.addEventListener("click", (ev) => { if (ev.target === inp) return; ev.preventDefault(); ev.stopPropagation(); inp.click(); });
    zona.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); inp.click(); } });
    zona.addEventListener("dragover", (ev) => { ev.preventDefault(); ev.stopPropagation(); zona.classList.add("sobre"); });
    zona.addEventListener("dragleave", () => zona.classList.remove("sobre"));
    zona.addEventListener("drop", (ev) => {
      ev.preventDefault(); ev.stopPropagation(); zona.classList.remove("sobre");
      const fs = [...(ev.dataTransfer?.files || [])];
      if (!fs.length) return;
      const dt = new DataTransfer();
      (inp.multiple ? fs : fs.slice(0, 1)).forEach((f) => dt.items.add(f));
      inp.files = dt.files;
      inp.dispatchEvent(new Event("change", { bubbles: true }));
    });
    mostrar();
  };
  const varrer = (raiz) => raiz.querySelectorAll && raiz.querySelectorAll('input[type="file"]').forEach(realcar);
  varrer(document);
  new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => { if (n.nodeType === 1) { if (n.matches?.('input[type="file"]')) realcar(n); varrer(n); } })))
    .observe(document.body, { childList: true, subtree: true });
  // com uma janela aberta, arquivo solto fora da área não abre no navegador (não perde o que foi digitado)
  const emJanela = (ev) => [...(ev.dataTransfer?.types || [])].includes("Files") && !document.getElementById("modal").hidden;
  document.addEventListener("dragover", (ev) => { if (emJanela(ev)) ev.preventDefault(); });
  document.addEventListener("drop", (ev) => { if (emJanela(ev) && !ev.target.closest(".zona-arquivo, .soltar")) ev.preventDefault(); });
};

/* ------------------------------------------------------------------ planilha única de importação (NF + budget) */
App.importacao = {};
/** Botões "Importar planilha" e "Baixar planilha de importação" (a mesma planilha para Notas fiscais, Budget e Documentos). */
App.importacao.botoes = function () {
  const inp = el("input", { type: "file", accept: ".xlsx,.xlsm", hidden: true });
  inp.onchange = () => { App.importacao.importar(inp.files); inp.value = ""; };
  return [inp,
    App.btnEditor("Importar Excel", () => inp.click(), "btn btn--linha"),
    el("a", { class: "btn btn--linha", href: "/api/importacao/modelo",
      title: "Planilha única (notas fiscais, contratos, pedidos, budget e documentos) com a guia LISTAS: listas suspensas e descrição puxada sozinha" },
      "Baixar modelo Excel")];
};

/** Relatório de eventos (eventos, avarias/MDO/insumos, medidores, chamados, energia e catálogo): importar Excel. */
App.importacao.botoesRelatorio = function (aoTerminar = () => App.rotear()) {
  return [App.btnEditor("Importar Excel", () => App.importacao.relatorio(aoTerminar), "btn btn--linha"),
    el("a", { class: "btn btn--linha", href: "/api/modelo-importacao",
      title: "Planilha com as guias EVENTOS, ITENS (avarias, MDO, insumos), MEDIDORES, CHAMADOS, ENERGIA e CATALOGO" }, "Baixar modelo Excel")];
};

App.importacao.relatorio = function (aoTerminar) {
  const inp = el("input", { type: "file", accept: ".xlsx,.xlsm" });
  const modos = [
    ["acrescentar", "Acrescentar as linhas da planilha", "Entra tudo o que está na planilha, sem apagar nada do site. Use para lançar dados novos."],
    ["substituir", "Substituir os dados dos eventos da planilha", "Para cada evento da planilha, os itens / medidores / chamados do site são trocados pelos da planilha (evita duplicar ao reimportar)."],
    ["completar", "Só completar o que está vazio", "Só entra o que o evento ainda não tem; nada que já existe é alterado."]];
  const radios = modos.map(([v, rot, ajuda], i) => {
    const r = el("input", { type: "radio", name: "modo-imp", value: v, checked: i === 0, style: { width: "auto", marginTop: "3px" } });
    return [r, el("label", { class: "opcao-imp" }, r, el("span", {}, el("b", {}, rot), el("small", {}, ajuda)))];
  });
  const msg = el("div", { style: { minHeight: "18px" } });
  const enviar = el("button", { class: "btn" }, "Importar");
  enviar.onclick = async () => {
    const f = inp.files[0];
    if (!f) { App.limpar(msg).append(el("p", { class: "ajuda", style: { color: "var(--perigo)" } }, "Escolha a planilha.")); return; }
    const fd = new FormData();
    fd.append("arquivo", f);
    fd.append("modo", radios.find(([r]) => r.checked)[0].value);
    enviar.disabled = true;
    App.limpar(msg).append(el("p", { class: "ajuda" }, "Importando… pode levar alguns segundos."));
    try {
      const r = await App.api("/api/importar", { method: "POST", body: fd });
      App.chamados = null; App.catalogo = null;
      await App.carregarEventos();
      if (r.anexos) {   // era o relatório de custos de um evento: foi anexado ao evento (medidores, energia, chamados)
        App.fecharModal();
        App.mostrarResultadosAnexo(r.anexos, aoTerminar);
        return;
      }
      App.limpar(msg).append(el("div", { class: "kpis kpis--compactos" },
        App.kpi("Eventos novos", App.fmt.num(r.eventos_novos), "core"),
        App.kpi("Avarias", App.fmt.num(r.avarias || 0), "p100"), App.kpi("MDO", App.fmt.num(r.mdo || 0), "p100"),
        App.kpi("Insumos", App.fmt.num(r.insumos || 0), "p100"), App.kpi("Medidores", App.fmt.num(r.relogios), "g200"),
        App.kpi("Chamados", App.fmt.num(r.chamados), "p100"), App.kpi("Catálogo", App.fmt.num(r.catalogo), "p100")));
      enviar.textContent = "Concluir"; enviar.disabled = false;
      enviar.onclick = () => { App.fecharModal(); aoTerminar(); };
      App.toast("Importação concluída.");
    } catch (e) { App.limpar(msg).append(el("p", { class: "ajuda", style: { color: "var(--perigo)" } }, e.message)); enviar.disabled = false; }
  };
  App.modal(el("div", { class: "modal--largo" }, el("h3", {}, "Importar Excel · Relatório de eventos"),
    el("p", { class: "ajuda", style: { marginTop: 0 } }, "Use o modelo (botão “Baixar modelo Excel”): guias EVENTOS, ITENS (avarias, MDO e insumos), MEDIDORES, CHAMADOS, ENERGIA e CATALOGO. ",
      "Guias que não usar podem ficar vazias. Também aceita a planilha antiga do Power BI."),
    el("label", { class: "campo" }, el("span", {}, "Planilha"), inp),
    el("div", { class: "grade", style: { gap: "8px", margin: "12px 0" } }, radios.map(([, l]) => l)),
    msg,
    el("div", { class: "linha-acoes" }, enviar, el("button", { class: "btn btn--linha", "data-fechar": "" }, "Cancelar"))));
};

App.importacao.importar = async function (files) {
  if (!files || !files.length) return;
  App.toast("Lendo a planilha…");
  const [r] = await App.enviarArquivos("/api/importacao", [files[0]]);
  if (r.erro) { App.toast(r.erro, true); return; }
  const chip = (t, ok = true) => el("span", { class: "etiqueta " + (ok ? "etiqueta--ok" : "") }, t);
  const blocos = [];
  const bloco = (titulo, chips, avisos) => blocos.push(el("div", { style: { marginBottom: "12px" } },
    el("h4", { style: { margin: "8px 0 6px" } }, titulo), el("div", { class: "chips" }, chips.filter(Boolean)),
    avisos && avisos.length ? el("ul", { class: "lista-simples", style: { marginTop: "6px" } }, avisos.slice(0, 40).map((t) => el("li", { style: { color: "var(--perigo)" } }, t))) : null));
  const L = r.listas, B = r.budget, N = r.nf, D = r.docs;
  if (L) bloco("LISTAS", [chip(`${L.cadastros} cadastro(s) novo(s)`, L.cadastros > 0), L.contratos ? chip(`${L.contratos} contrato(s) novo(s)`) : null,
    L.pedidos ? chip(`${L.pedidos} pedido(s) novo(s)`) : null]);
  if (B) bloco("Budget e pedidos", [chip(`${B.pedidos} pedido(s) novo(s)`, B.pedidos > 0), B.pedidos_completados ? chip(`${B.pedidos_completados} pedido(s) completado(s)`) : null,
    chip(`${B.budget_novos} linha(s) de budget nova(s)`, B.budget_novos > 0), B.budget_atualizados ? chip(`${B.budget_atualizados} linha(s) com solicitado / aprovado atualizados`) : null,
    B.realocacoes ? chip(`${B.realocacoes} realocação(ões)`) : null, B.cadastros ? chip(`${B.cadastros} cadastro(s) novo(s)`) : null,
    chip(`${B.ja_existiam} já estavam iguais`, false)], B.avisos);
  if (N) bloco("Notas fiscais", [chip(`${N.medicoes} medição(ões) nova(s)`, N.medicoes > 0), N.medicoes_completadas ? chip(`${N.medicoes_completadas} medição(ões) completada(s)`) : null,
    N.contratos ? chip(`${N.contratos} contrato(s) novo(s)`) : null, N.contratos_completados ? chip(`${N.contratos_completados} contrato(s) completado(s)`) : null,
    N.itens_contrato ? chip(`${N.itens_contrato} item(ns) de contrato`) : null, N.prazos ? chip(`${N.prazos} prazo(s)`) : null,
    N.feriados ? chip(`${N.feriados} feriado(s)`) : null, chip(`${N.ja_existiam} já estavam iguais`, false),
    N.classe_auto ? chip(`${N.classe_auto} medição(ões) com a classe do contrato (linha única)`) : null,
    N.classe_planilha ? chip(`${N.classe_planilha} medição(ões) com a classe digitada na planilha`) : null], N.avisos);
  if (N && N.sem_classe && N.sem_classe.length) blocos.push(el("div", { class: "aviso-classe" },
    el("b", {}, `${N.sem_classe.length} medição(ões) entraram sem classe financeira`),
    el("p", {}, "O contrato delas não tem linha com classe ou tem várias linhas diferentes. Abra cada uma em Notas fiscais › Medições e escolha o item (linha) do contrato, ",
      "ou preencha ITEM / PROJETO + CLASSE FINANCEIRA na planilha e importe de novo."),
    el("ul", { class: "lista-simples" }, N.sem_classe.slice(0, 40).map((t) => el("li", {}, t))),
    N.sem_classe.length > 40 ? el("p", { class: "ajuda" }, `… e mais ${N.sem_classe.length - 40}.`) : null,
    el("a", { class: "btn btn--linha btn--mini", href: "#/nf/medicoes", "data-fechar": "",
      onclick: () => { try { sessionStorage.setItem("nf_filtro_med", JSON.stringify({ classe: "sem" })); } catch (e) { /* ok */ }
        if (location.hash === "#/nf/medicoes") setTimeout(App.rotear, 0); } }, "Ver medições sem classe")));
  if (D && (D.novos || D.atualizados || D.ja_existiam)) bloco("Documentos", [chip(`${D.novos} documento(s) novo(s)`, D.novos > 0), D.atualizados ? chip(`${D.atualizados} documento(s) atualizado(s)`) : null,
    chip(`${D.ja_existiam} já estavam iguais`, false)], D.avisos);
  App.modal(el("div", { class: "modal--largo" }, el("h3", {}, "Planilha importada"),
    el("p", { class: "ajuda", style: { marginTop: 0 } }, "Entra só o que falta: o que já está no site não é duplicado (só os campos vazios são completados). No budget, o solicitado / aprovado da planilha substitui o do site; nos documentos, as datas preenchidas atualizam as do site."),
    blocos,
    r.sem_acesso && r.sem_acesso.length ? el("p", { class: "ajuda", style: { color: "var(--perigo)" } }, "Sem acesso, não importado: " + r.sem_acesso.join(", ")) : null,
    el("div", { class: "linha-acoes" }, el("button", { class: "btn", "data-fechar": "", onclick: () => App.rotear() }, "OK"))));
};

/* Etiquetas de texto longo dentro de tabelas podem quebrar em 2 linhas (as curtas, como "1 linha(s)", ficam numa linha só). */
(function () {
  let pend = false;
  const marcar = () => {
    pend = false;
    document.querySelectorAll(".tabela .etiqueta:not([data-q])").forEach((e) => {
      e.dataset.q = "1";
      if (e.textContent.trim().length > 12 && /\s/.test(e.textContent.trim())) e.classList.add("etiqueta--quebra");
    });
  };
  const iniciar = () => new MutationObserver(() => { if (!pend) { pend = true; requestAnimationFrame(marcar); } }).observe(document.body, { childList: true, subtree: true });
  if (document.body) iniciar(); else document.addEventListener("DOMContentLoaded", iniciar);
})();
