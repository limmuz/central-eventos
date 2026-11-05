/* Comportamentos de interface que valem para o site inteiro:
   lista suspensa com busca, retorno imediato de carregamento, botão ocupado, filtros enxutos, ações agrupadas e progresso de formulário. */
"use strict";

/* ------------------------------------------------------------------ lista suspensa com busca
   O <select> original continua no lugar (escondido): as telas seguem lendo .value e ouvindo "change" como sempre. */
const BUSCA_MIN_OPCOES = 6;   // listas curtas ficam no padrão do navegador: buscar em 3 opções só atrapalha
const BUSCA_SEMPRE = /centro de custo|projeto|classe|contrato|fornecedor|pedido|evento|item/i;   // listas que crescem têm busca desde o começo
const DESC_VALOR = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
const DESC_INDICE = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "selectedIndex");
const POP_MAX_ITENS = 300;
let popAberto = null;

const fecharPop = (devolverFoco = false) => {
  if (!popAberto) return;
  const { pop, botao } = popAberto;
  pop.remove();
  botao.setAttribute("aria-expanded", "false");
  popAberto = null;
  if (devolverFoco) botao.focus();
};
document.addEventListener("mousedown", (e) => { if (popAberto && !e.target.closest(".sel-busca__pop")) fecharPop(); }, true);
window.addEventListener("resize", () => fecharPop());
window.addEventListener("hashchange", () => fecharPop());
document.addEventListener("scroll", (e) => { if (popAberto && !(e.target.closest && e.target.closest(".sel-busca__pop"))) fecharPop(); }, true);

App.comBusca = function (sel) {
  if (sel._comBusca || sel.multiple) return;
  sel._comBusca = true;
  const rotulo = el("span", { class: "sel-busca__rotulo" });
  const botao = el("button", { class: "sel-busca__botao", type: "button", "aria-haspopup": "listbox", "aria-expanded": "false" }, rotulo);
  const caixa = el("span", { class: "sel-busca" });
  if (sel.style.width) caixa.style.width = sel.style.width;
  sel.parentNode.insertBefore(caixa, sel);
  caixa.append(botao, sel);   // o botão vem primeiro: clicar no rótulo do campo abre a lista
  sel.classList.add("sel-busca__nativo");
  sel.tabIndex = -1;
  sel.setAttribute("aria-hidden", "true");

  const nomeCampo = () => sel.getAttribute("aria-label") || sel.closest(".campo")?.querySelector(":scope > span")?.textContent || "Lista";
  const atualizar = () => {
    const o = sel.options[DESC_INDICE.get.call(sel)];
    rotulo.textContent = o ? o.textContent : "";
    botao.title = rotulo.textContent;
    botao.disabled = sel.disabled;
    botao.setAttribute("aria-label", `${nomeCampo()}: ${rotulo.textContent || "nada escolhido"}`);
    caixa.hidden = sel.hidden;
  };
  Object.defineProperty(sel, "value", { configurable: true, get: () => DESC_VALOR.get.call(sel), set: (v) => { DESC_VALOR.set.call(sel, v); atualizar(); } });
  Object.defineProperty(sel, "selectedIndex", { configurable: true, get: () => DESC_INDICE.get.call(sel), set: (v) => { DESC_INDICE.set.call(sel, v); atualizar(); } });
  sel.focus = () => botao.focus();
  new MutationObserver(atualizar).observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "hidden", "selected"] });
  sel.addEventListener("change", atualizar);

  const escolher = (valor) => {
    DESC_VALOR.set.call(sel, valor);
    atualizar();
    fecharPop(true);
    if (sel.closest("#modal")) App._modal.sujo = true;
    sel.dispatchEvent(new Event("input", { bubbles: true }));
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const abrir = () => {
    fecharPop();
    const opcoes = [...sel.options].filter((o) => !o.disabled && !o.hidden).map((o) => ({
      valor: o.value, texto: o.textContent, busca: App.norm(o.textContent), grupo: o.parentElement.tagName === "OPTGROUP" ? o.parentElement.label : "",
    }));
    const busca = el("input", { type: "search", class: "sel-busca__busca", placeholder: "Digite para buscar…", autocomplete: "off",
      role: "combobox", "aria-expanded": "true", "aria-autocomplete": "list", "aria-label": `Buscar em ${nomeCampo()}` });
    const lista = el("div", { class: "sel-busca__lista", role: "listbox", "aria-label": nomeCampo() });
    const conta = el("div", { class: "sel-busca__conta", "aria-live": "polite" });
    const pop = el("div", { class: "sel-busca__pop" }, busca, lista, conta);
    let visiveis = [], foco = 0;
    const marcar = () => {
      lista.querySelectorAll("[role=option]").forEach((n, i) => {
        n.classList.toggle("foco", i === foco);
        if (i === foco) { busca.setAttribute("aria-activedescendant", n.id); n.scrollIntoView({ block: "nearest" }); }
      });
    };
    const desenhar = () => {
      const termos = App.norm(busca.value).split(/\s+/).filter(Boolean);
      visiveis = opcoes.filter((o) => termos.every((t) => o.busca.includes(t)));
      App.limpar(lista);
      let grupo = null;
      visiveis.slice(0, POP_MAX_ITENS).forEach((o, i) => {
        if (o.grupo && o.grupo !== grupo) { grupo = o.grupo; lista.append(el("div", { class: "sel-busca__grupo" }, grupo)); }
        const n = el("div", { class: "sel-busca__item", role: "option", id: `sb-${i}`, "aria-selected": String(o.valor === sel.value) }, o.texto || "—");
        n.addEventListener("mousedown", (ev) => { ev.preventDefault(); escolher(o.valor); });
        lista.append(n);
      });
      if (!visiveis.length) lista.append(el("div", { class: "sel-busca__vazio" }, "Nada encontrado. Confira a grafia ou tente outro termo."));
      conta.textContent = visiveis.length > POP_MAX_ITENS ? `Mostrando ${POP_MAX_ITENS} de ${visiveis.length}: digite para refinar`
        : `${visiveis.length} de ${opcoes.length}`;
      foco = Math.max(0, termos.length ? 0 : visiveis.findIndex((o) => o.valor === sel.value));
      marcar();
    };
    busca.addEventListener("input", desenhar);
    busca.addEventListener("keydown", (ev) => {
      const fim = Math.min(visiveis.length, POP_MAX_ITENS) - 1;
      if (ev.key === "ArrowDown") { foco = Math.min(foco + 1, fim); marcar(); ev.preventDefault(); }
      else if (ev.key === "ArrowUp") { foco = Math.max(foco - 1, 0); marcar(); ev.preventDefault(); }
      else if (ev.key === "Enter") { if (visiveis[foco]) escolher(visiveis[foco].valor); ev.preventDefault(); }
      else if (ev.key === "Escape") { fecharPop(true); }
      else if (ev.key === "Tab") { fecharPop(true); ev.preventDefault(); return; }
      else return;
      ev.stopPropagation();   // Esc fecha só a lista, não a janela
    });
    document.body.append(pop);
    const r = botao.getBoundingClientRect(), largura = Math.min(Math.max(r.width, 320), innerWidth - 16);
    const abaixo = innerHeight - r.bottom - 8, acima = r.top - 8, paraCima = abaixo < 260 && acima > abaixo;
    pop.style.width = `${largura}px`;
    pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - largura - 8))}px`;
    pop.style.maxHeight = `${Math.max(200, Math.min(paraCima ? acima : abaixo, 420))}px`;
    if (paraCima) pop.style.bottom = `${innerHeight - r.top + 4}px`; else pop.style.top = `${r.bottom + 4}px`;
    popAberto = { pop, botao };
    botao.setAttribute("aria-expanded", "true");
    desenhar();
    busca.focus();
  };
  botao.addEventListener("click", (ev) => {
    ev.preventDefault();
    if (popAberto && popAberto.botao === botao) fecharPop(); else abrir();
  });
  botao.addEventListener("keydown", (ev) => {
    if (["ArrowDown", "ArrowUp"].includes(ev.key)) { ev.preventDefault(); abrir(); }
  });
  atualizar();
};

/** Toda lista com opções suficientes ganha busca, em qualquer tela, inclusive as criadas depois. */
App.realcarListas = function () {
  document.querySelectorAll("select:not(.sel-busca__nativo):not([multiple])").forEach((s) => {
    if (!s.parentNode) return;
    const campo = s.closest(".campo")?.querySelector(":scope > span")?.textContent || s.getAttribute("aria-label") || "";
    if (s.options.length >= BUSCA_MIN_OPCOES || BUSCA_SEMPRE.test(campo)) App.comBusca(s);
  });
};
let filaListas = false;
new MutationObserver(() => {
  if (filaListas) return;
  filaListas = true;
  requestAnimationFrame(() => { filaListas = false; App.realcarListas(); });
}).observe(document.body, { childList: true, subtree: true });

/* ------------------------------------------------------------------ retorno imediato: barra de carregamento e botão ocupado */
const barraCarga = el("div", { class: "barra-carga", role: "progressbar", "aria-label": "Carregando", hidden: true });
document.body.prepend(barraCarga);
let emAndamento = 0, tCarga = null, ultimoClique = null;
document.addEventListener("click", (e) => {
  const b = e.target.closest && e.target.closest("button.btn");
  ultimoClique = b ? { b, t: performance.now() } : null;
}, true);
const fetchOriginal = window.fetch.bind(window);
window.fetch = function (url, opts = {}) {
  const u = String(url && url.url ? url.url : url);
  if (!u.startsWith("/api/") || u === "/api/solicitacoes/pendentes") return fetchOriginal(url, opts);
  emAndamento++;
  clearTimeout(tCarga);
  tCarga = setTimeout(() => { if (emAndamento) barraCarga.hidden = false; }, 120);
  // o botão clicado fica ocupado até a resposta: mostra que recebeu o clique e evita salvar duas vezes
  let botao = null;
  if (ultimoClique && performance.now() - ultimoClique.t < 400 && !ultimoClique.b.disabled && (opts.method || "GET") !== "GET") {
    botao = ultimoClique.b;
    botao.disabled = true;
    botao.classList.add("btn--ocupado");
    botao.setAttribute("aria-busy", "true");
  }
  return fetchOriginal(url, opts).then((r) => {
    const grupo = r.headers.get("X-Lixeira");
    if (grupo) setTimeout(() => App.toast("Excluído.", false, { acao: { rotulo: "Desfazer", fazer: () => App.desfazerExclusao(grupo) } }), 250);   // depois do aviso da própria tela
    return r;
  }).finally(() => {
    emAndamento--;
    if (!emAndamento) { clearTimeout(tCarga); barraCarga.hidden = true; }
    if (botao) { botao.disabled = false; botao.classList.remove("btn--ocupado"); botao.removeAttribute("aria-busy"); }
  });
};

/* ------------------------------------------------------------------ avisos: sucesso marcado, erro fica mais tempo, ação opcional */
App.toast = function (msg, erro = false, { acao = null } = {}) {
  const t = document.getElementById("toast");
  App.limpar(t).append(el("span", {}, (erro || /…$/.test(msg) ? "" : "✓ ") + msg));   // "Lendo…" ainda não terminou: sem o visto
  if (acao) {
    t.append(el("button", { class: "toast__acao", type: "button", onclick: () => { t.className = "toast"; acao.fazer(); } }, acao.rotulo));
  }
  t.append(el("button", { class: "toast__fechar", type: "button", "aria-label": "Fechar aviso", onclick: () => { t.className = "toast"; } }, "×"));
  t.setAttribute("role", erro ? "alert" : "status");
  t.className = "toast vis" + (erro ? " erro" : "");
  clearTimeout(App._tt);
  App._tt = setTimeout(() => (t.className = "toast"), erro || acao ? 9000 : 3600);
};

/* ------------------------------------------------------------------ filtros enxutos
   Mostra a busca e os dois primeiros campos; o resto fica em "Mais filtros", que abre sozinho se houver algo preenchido. */
App.filtrosEnxutos = function (barra, visiveis = 2) {
  const filhos = [...barra.children];
  const limpar = filhos.find((c) => c.classList.contains("limpar"));
  const busca = filhos.find((c) => c.classList.contains("campo--cresce"));
  const campos = filhos.filter((c) => c !== limpar && c !== busca);
  if (busca) barra.prepend(busca);   // a busca é o primeiro lugar onde se procura
  if (campos.length <= visiveis + 1) return barra;
  const extras = campos.slice(visiveis);
  const mais = el("div", { class: "filtros__mais", hidden: true }, extras);
  const preenchidos = () => extras.reduce((n, c) => n
    // a primeira opção de cada lista é o padrão ("Todos"): não conta como filtro em uso
    + [...c.querySelectorAll("select, input")].filter((x) => (x.tagName === "SELECT" ? x.selectedIndex > 0 : x.type === "checkbox" ? x.checked : !!x.value)).length
    + [...c.querySelectorAll(".chip[aria-pressed=true]")].filter((x) => !/^(tudo|todos|todas|ativos)$/i.test(x.textContent.trim())).length, 0);   // "Tudo" é o padrão
  const botao = el("button", { class: "btn btn--linha btn--mini filtros__botao", type: "button", "aria-expanded": "false" });
  const atualizar = () => {
    const n = preenchidos();
    botao.textContent = (mais.hidden ? "Mais filtros" : "Menos filtros") + (n ? ` (${n})` : "");
    botao.setAttribute("aria-expanded", String(!mais.hidden));
  };
  botao.addEventListener("click", () => {
    mais.hidden = !mais.hidden;
    try { localStorage.setItem("rge_mais_filtros", mais.hidden ? "0" : "1"); } catch (e) { /* ok */ }
    atualizar();
  });
  barra.addEventListener("change", atualizar);
  barra.addEventListener("click", () => setTimeout(atualizar));
  barra.insertBefore(mais, limpar || null);
  barra.insertBefore(botao, limpar || null);
  setTimeout(() => {
    let lembrado = false;
    try { lembrado = localStorage.getItem("rge_mais_filtros") === "1"; } catch (e) { /* ok */ }
    if (preenchidos() || lembrado) mais.hidden = false;
    atualizar();
  });
  atualizar();
  return barra;
};

/* ------------------------------------------------------------------ cabeçalho das páginas
   Ação principal primeiro e em destaque; Exportar ao lado; o resto (importar, modelos...) em "Mais ações". */
App.organizarAcoes = function (raiz) {
  raiz.querySelectorAll(".pagina-cabecalho > .acoes").forEach((ac) => {
    if (ac.dataset.organizado) return;
    ac.dataset.organizado = "1";
    const itens = [...ac.children].filter((x) => !(x.tagName === "INPUT" && x.type === "file"));
    const ePrincipal = (x) => x.matches("a.btn, button.btn") && !x.matches(".btn--linha, .btn--sec, .btn--fantasma");
    const principal = [...itens].reverse().find(ePrincipal);
    if (principal) ac.prepend(principal);
    const exportar = itens.find((x) => x.querySelector && x.querySelector(".menu-exportar"));
    const resto = itens.filter((x) => x !== principal && x !== exportar);
    ac.append(...[principal, exportar, ...resto].filter(Boolean));   // sempre na mesma ordem, em todas as telas
    if (resto.length < 2) return;
    const menu = el("div", { class: "menu-exportar menu-mais", hidden: true, role: "menu" }, resto);
    const botao = el("button", { class: "btn btn--linha", type: "button", "aria-haspopup": "menu", "aria-expanded": "false" }, "Mais ações ▾");
    const fechar = () => { menu.hidden = true; botao.setAttribute("aria-expanded", "false"); };
    botao.addEventListener("click", (ev) => {
      ev.stopPropagation();
      menu.hidden = !menu.hidden;
      botao.setAttribute("aria-expanded", String(!menu.hidden));
      App.menuNaTela(menu);
    });
    menu.addEventListener("click", fechar);
    document.addEventListener("click", (ev) => { if (!ev.target.closest(".menu-mais")) fechar(); });
    ac.append(el("div", { class: "menu-mais__caixa" }, botao, menu));
  });
};

/* ------------------------------------------------------------------ progresso de formulário
   itens: [{ rotulo, ok: () => bool }]. Mostra quanto falta e o que falta, atualizando enquanto a pessoa preenche. */
App.progressoForm = function (itens) {
  const barra = el("div", { class: "form-progresso__barra" }), txt = el("span");
  const caixa = el("div", { class: "form-progresso", role: "status" }, el("div", { class: "form-progresso__trilho" }, barra), txt);
  const atualizar = () => {
    const faltam = itens.filter((i) => !i.ok());
    const feitos = itens.length - faltam.length;
    barra.style.width = `${Math.round((100 * feitos) / itens.length)}%`;
    caixa.classList.toggle("form-progresso--pronto", !faltam.length);
    txt.textContent = faltam.length ? `${feitos} de ${itens.length} · falta: ${faltam.map((i) => i.rotulo).join(", ")}` : "Tudo preenchido: pronto para salvar.";
  };
  const aoMudar = () => { if (caixa.isConnected) atualizar(); else if (caixa._ligado) { document.removeEventListener("input", aoMudar, true); document.removeEventListener("change", aoMudar, true); document.removeEventListener("click", aoMudar2, true); } };
  const aoMudar2 = () => setTimeout(aoMudar);
  document.addEventListener("input", aoMudar, true);
  document.addEventListener("change", aoMudar, true);
  document.addEventListener("click", aoMudar2, true);
  caixa._ligado = true;
  atualizar();
  return caixa;
};

/* ------------------------------------------------------------------ prevenção de erro: número colado no formato brasileiro */
document.addEventListener("paste", (e) => {
  const t = e.target;
  if (!t || t.tagName !== "INPUT" || t.type !== "number") return;
  const bruto = (e.clipboardData || window.clipboardData).getData("text").replace(/[R$\s]/g, "");
  if (!/^-?[\d.,]+$/.test(bruto)) return;
  const n = bruto.includes(",") ? bruto.replace(/\./g, "").replace(",", ".") : bruto;   // "1.234,56" -> 1234.56
  if (isNaN(parseFloat(n))) return;
  e.preventDefault();
  t.value = n;
  t.dispatchEvent(new Event("input", { bubbles: true }));
  t.dispatchEvent(new Event("change", { bubbles: true }));
});

/* ------------------------------------------------------------------ indicadores em blocos
   Até 4 números à vista; os demais ficam a um clique. Vale também para o que a tela redesenha depois de filtrar. */
const KPIS_VISIVEIS = 4;
let kpisAbertos = false;
try { kpisAbertos = localStorage.getItem("rge_mais_numeros") === "1"; } catch (e) { /* ok */ }
App.organizarKpis = function (raiz) {
  raiz.querySelectorAll(".kpis:not([data-enxuto])").forEach((caixa) => {
    const itens = [...caixa.children].filter((x) => x.classList.contains("kpi"));
    caixa.dataset.enxuto = "1";
    if (itens.length <= KPIS_VISIVEIS + 1) return;
    const extras = itens.slice(KPIS_VISIVEIS);
    extras.forEach((k) => k.classList.add("kpi--extra"));
    const botao = el("button", { class: "btn btn--linha btn--mini kpis__botao", type: "button" });
    const pintar = () => {
      extras.forEach((k) => (k.hidden = !kpisAbertos));
      botao.textContent = kpisAbertos ? "Ver menos números" : `Ver mais ${extras.length} números`;
      botao.setAttribute("aria-expanded", String(kpisAbertos));
    };
    botao.addEventListener("click", () => {
      kpisAbertos = !kpisAbertos;
      try { localStorage.setItem("rge_mais_numeros", kpisAbertos ? "1" : "0"); } catch (e) { /* ok */ }
      document.querySelectorAll(".kpis__botao").forEach((b) => b !== botao && b.dispatchEvent(new Event("repintar")));
      pintar();
    });
    botao.addEventListener("repintar", pintar);
    caixa.after(el("div", { class: "kpis__mais" }, botao));
    pintar();
  });
};
let filaKpis = false;
new MutationObserver(() => {
  if (filaKpis) return;
  filaKpis = true;
  requestAnimationFrame(() => { filaKpis = false; App.organizarKpis(document.getElementById("app")); });
}).observe(document.getElementById("app"), { childList: true, subtree: true });

/* ------------------------------------------------------------------ desfazer exclusão: o servidor só oferece ao administrador */
App.desfazerExclusao = async function (grupo) {
  try {
    const r = await App.api(`/api/lixeira/${grupo}/restaurar`, { method: "POST" });
    App.catalogo = null; App.chamados = null; App.avarias = null;
    await App.carregarEventos();
    if ((App.meta.acessos || []).includes("docs") && App.docs) await App.docs.carregar().catch(() => {});
    App.toast(`Restaurado: ${r.resumo}${r.arquivos_faltando ? ` (${r.arquivos_faltando} arquivo(s) não voltaram)` : ""}.`);
    App.rotear();
  } catch (e) { App.toast(e.message, true); }
};
