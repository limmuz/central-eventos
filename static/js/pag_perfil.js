/* Página: Perfil (foto, senha, sair, pedir módulos) + Configurações por categoria + para o admin: solicitações e equipe.
   As telas de Configurações são as dos próprios módulos, abertas aqui dentro. */
"use strict";

const PF_CATEGORIAS = [
  ["relatorio", "Relatório de eventos", (c) => App.paginas.catalogo(c)],
  ["nf", "Notas fiscais", (c) => App.paginas.nf(c, ["config"])],
  ["budget", "Budget", (c) => App.paginas.budget(c, ["cadastros"])],
  ["sup", "Suprimentos", (c) => App.paginas.sup(c, ["config"])],
];
const PF_SITUACAO = {
  pendente: ["Pendente", " etiqueta--alerta"],
  aprovada: ["Aprovada", " etiqueta--ok"],
  recusada: ["Recusada", ""],
};
const pfNomeGuia = (g) => (App.meta.guias || {})[g] || g;
const pfQuando = (q) => (q ? q.slice(0, 16).split(" ").map((p, i) => (i ? p : App.fmt.data(p))).join(" ") : "—");
const pfChips = (mods) => el("div", { class: "chips" }, App.guiasEmOrdem(mods).map((g) => el("span", { class: "etiqueta" }, pfNomeGuia(g))));
const pfSituacao = (s) => el("span", { class: "etiqueta" + PF_SITUACAO[s.situacao][1] }, PF_SITUACAO[s.situacao][0]);

App.paginas.perfil = async function (raiz, params) {
  if (!App.temPerfil()) { location.replace("#/visao"); return; }
  const m = App.meta;
  const podePedir = !!m.usuario && m.usuario.perfil !== "admin";
  const abas = [
    ["conta", "Meu perfil", pfConta],
    podePedir ? ["solicitar", "Solicitar acesso", pfSolicitar] : null,
    ["configuracoes", "Configurações", (c) => pfConfiguracoes(c, params[1])],
    m.admin ? ["solicitacoes", "Solicitações", pfSolicitacoes] : null,
    m.admin ? ["equipe", "Equipe", async (c) => { await App.paginas.equipe(c); App.exportarExcel = null; pfBotaoExportar(c); }] : null,
    m.admin ? ["lixeira", "Lixeira", pfLixeira] : null,
  ].filter(Boolean);
  const aba = abas.find(([k]) => k === (params[0] || "conta"));
  if (!aba) { location.replace("#/perfil"); return; }
  const corpo = el("div");
  raiz.append(
    el("div", { class: "pagina-cabecalho" }, el("div", {}, el("h2", {}, "Meu perfil"), el("p", {}, App.nomePerfil()))),
    el("nav", { class: "subabas subabas--grandes", "aria-label": "Seções do perfil" }, abas.map(([k, rot]) =>
      el("a", { href: "#/perfil/" + (k === "conta" ? "" : k), class: k === aba[0] ? "ativa" : null, "aria-current": k === aba[0] ? "page" : null }, rot,
        k === "solicitacoes" && m.pendentes ? el("span", { class: "abas__badge" }, String(m.pendentes)) : null))),
    corpo);
  await aba[2](corpo);
  if (["solicitacoes", "lixeira"].includes(aba[0])) { App.exportarExcel = null; pfBotaoExportar(raiz); }   // PDF também nestas listas
};

/** Recarrega os dados de quem está logado (foto, módulos, pendências) e redesenha a página. */
async function pfAtualizar() {
  App.meta = await App.api("/api/meta");
  App.atualizarCadeado();
  App.rotear();
}

/** Recorta o centro da imagem e reduz para 256x256 em JPEG (assim a foto fica leve na pasta de rede). */
async function pfPrepararFoto(arquivo) {
  const img = await createImageBitmap(arquivo);
  const lado = Math.min(img.width, img.height);
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  g.fillStyle = "#fff";   // PNG com fundo transparente não fica preto
  g.fillRect(0, 0, 256, 256);
  g.drawImage(img, (img.width - lado) / 2, (img.height - lado) / 2, lado, lado, 0, 0, 256, 256);
  img.close();
  return new Promise((res) => c.toBlob(res, "image/jpeg", 0.85));
}

function pfConta(corpo) {
  const m = App.meta, u = m.usuario, temFoto = !!(u || m.entrou_local);
  const arquivo = el("input", { type: "file", accept: "image/*", hidden: true, "aria-label": "Escolher foto" });
  arquivo.addEventListener("change", async () => {
    const f = arquivo.files[0];
    if (!f) return;
    try {
      const blob = await pfPrepararFoto(f);
      await App.api("/api/perfil/foto", { method: "POST", body: blob, headers: { "Content-Type": "image/jpeg" } });
      App.toast("Foto atualizada.");
      await pfAtualizar();
    } catch (e) { App.toast(e.name === "InvalidStateError" ? "Não consegui abrir essa imagem. Tente outro arquivo." : e.message, true); }
  });
  const papel = m.admin ? "Administrador" : u ? "Editor" : "Edição por senha";
  corpo.append(el("div", { class: "perfil-grade" },
    temFoto ? App.cartao("Minha foto", "aparece no topo do site sempre que você entra",
      el("div", { class: "perfil-foto" }, el("div", { class: "avatar avatar--grande" }, App.elFoto()),
        el("div", { class: "linha-acoes", style: { marginTop: 0 } },
          el("button", { class: "btn", type: "button", onclick: () => arquivo.click() }, m.foto ? "Trocar foto" : "Enviar foto"),
          m.foto ? el("button", { class: "btn btn--linha", type: "button", onclick: async () => {
            try { await App.api("/api/perfil/foto", { method: "DELETE" }); App.toast("Foto removida."); await pfAtualizar(); } catch (e) { App.toast(e.message, true); }
          } }, "Remover foto") : null), arquivo)) : null,
    App.cartao("Minha conta", papel,
      el("dl", { class: "perfil-dados" },
        el("dt", {}, "Nome"), el("dd", {}, App.nomePerfil()),
        u ? el("dt", {}, "Usuário") : null, u ? el("dd", {}, u.login) : null,
        el("dt", {}, "Módulos"), el("dd", {}, pfChips(m.acessos || [])),
        u && u.area ? el("dt", {}, "Área") : null, u && u.area ? el("dd", {}, u.area) : null,
        m.visao ? el("dt", {}, "Visão") : null,
        m.visao ? el("dd", {}, [m.visao.centros.length ? `Centros de custo: ${m.visao.centros.join(", ")}` : "", m.visao.projetos.length ? `Projetos: ${m.visao.projetos.join(", ")}` : ""].filter(Boolean).join(" · ")) : null),
      el("div", { class: "linha-acoes" },
        u ? el("button", { class: "btn btn--linha", type: "button", onclick: App.trocarMinhaSenha }, "Trocar senha") : null,
        el("button", { class: "btn btn--linha", type: "button", onclick: App.alternarEdicao }, "Sair da conta")))));
}

async function pfSolicitar(corpo) {
  const pedidos = await App.api("/api/solicitacoes/minhas");
  const pendentes = new Set(pedidos.filter((p) => p.situacao === "pendente").flatMap((p) => p.modulos));
  // relatório aparece para quem só visualiza: a guia na conta é o que libera editar
  const naConta = (() => { try { return JSON.parse(App.meta.usuario.acessos || "[]"); } catch (e) { return []; } })();
  const livres = App.guiasEmOrdem(Object.keys(App.meta.guias || {})).filter((g) => !naConta.includes(g) && !pendentes.has(g));
  const caixas = livres.map((g) => { const c = el("input", { type: "checkbox", value: g }); return { c, linha: el("label", {}, c, el("span", {}, g === "relatorio" ? "Relatório de eventos (editar)" : pfNomeGuia(g))) }; });
  const motivo = el("textarea", { rows: 2, maxlength: 500, placeholder: "para que você precisa do acesso…" });
  const msg = el("p", { class: "ajuda", style: { color: "var(--perigo)", minHeight: "18px" } });
  const enviar = async () => {
    try {
      await App.api("/api/solicitacoes/modulo", { method: "POST", json: { modulos: caixas.filter((x) => x.c.checked).map((x) => x.c.value), motivo: motivo.value } });
      App.toast("Pedido enviado ao administrador.");
      App.rotear();
    } catch (e) { msg.textContent = e.message; }
  };
  corpo.append(
    App.cartao("Pedir acesso a outros módulos", "o administrador recebe o pedido e libera na sua conta",
      livres.length ? el("div", { class: "perfil-pedido" },
        el("div", { class: "campo" }, el("span", {}, "Módulos"), el("div", { class: "acessos-lista" }, caixas.map((x) => x.linha))),
        el("label", { class: "campo" }, el("span", {}, "Motivo (opcional)"), motivo), msg,
        el("div", { class: "linha-acoes" }, el("button", { class: "btn", type: "button", onclick: enviar }, "Enviar pedido")))
        : el("p", { class: "ajuda" }, "Você já tem ou já pediu todos os módulos.")),
    el("div", { style: { height: "16px" } }),
    App.cartao("Meus pedidos", "resposta do administrador",
      App.tabela([
        { rotulo: "Módulos", valor: (p) => p.modulos.map(pfNomeGuia).join(", "), render: (p) => pfChips(p.modulos) },
        { rotulo: "Motivo", valor: (p) => p.motivo },
        { rotulo: "Pedido em", valor: (p) => p.criado_em, render: (p) => pfQuando(p.criado_em) },
        { rotulo: "Situação", valor: (p) => p.situacao, render: pfSituacao },
        { rotulo: "Respondido em", oculta: true, valor: (p) => p.resolvido_em || "", render: (p) => pfQuando(p.resolvido_em) },
      ], pedidos, { vazio: "Nenhum pedido ainda." })));
}

async function pfConfiguracoes(corpo, categoria) {
  const cats = PF_CATEGORIAS.filter(([g]) => (App.meta.acessos || []).includes(g));
  if (!cats.length) { corpo.append(el("div", { class: "cartao vazio" }, "Nenhum módulo com configurações liberado para a sua conta.")); return; }
  const cat = cats.find(([g]) => g === categoria) || cats[0];
  const tela = el("div");
  App.ajustarEdicao(cat[0]);
  corpo.append(
    el("nav", { class: "subabas", "aria-label": "Categorias das configurações" }, cats.map(([g, rot]) =>
      el("a", { href: `#/perfil/configuracoes/${g}`, class: g === cat[0] ? "ativa" : null, "aria-current": g === cat[0] ? "page" : null }, rot))),
    tela);
  await cat[2](tela);
  // Exportar (sempre com PDF): o roteador só coloca o botão nas rotas dos módulos
  if (cat[0] === "relatorio") App.exportarExcel = { rotulo: "Base de eventos (Power BI)", url: "/api/exportar" };
  else if (cat[0] !== "budget") App.exportarExcel = null;
  pfBotaoExportar(tela);
}

function pfBotaoExportar(tela) {
  const cab = tela.querySelector(".pagina-cabecalho");
  if (!cab) return;
  let ac = cab.querySelector(".acoes");
  if (!ac) { ac = el("div", { class: "acoes" }); cab.append(ac); }
  ac.prepend(App.botaoExportar());
}

async function pfSolicitacoes(corpo) {
  const lista = await App.api("/api/solicitacoes");
  const recusar = async (s) => {
    if (!(await App.confirmar("Recusar pedido", `Recusar o pedido de ${s.nome}?`, "Recusar"))) return;
    try { await App.api(`/api/solicitacoes/${s.id}/recusar`, { method: "POST" }); App.toast("Pedido recusado."); await pfAtualizar(); } catch (e) { App.toast(e.message, true); }
  };
  const aprovarModulo = async (s) => {
    try { await App.api(`/api/solicitacoes/${s.id}/aprovar`, { method: "POST" }); App.toast(`Acesso liberado para ${s.nome}.`); await pfAtualizar(); } catch (e) { App.toast(e.message, true); }
  };
  const aprovarLogin = (s) => App.editarConta({ nome: s.nome, acessos: JSON.stringify(s.modulos), solicitacao_id: s.id });
  const acoes = (aprovar) => ({ rotulo: "", fixa: true, render: (s) => s.situacao !== "pendente" ? "" : el("span", { class: "perfil-acoes" },
    el("button", { class: "btn btn--mini", type: "button", onclick: () => aprovar(s) }, "Aprovar"),
    el("button", { class: "btn btn--mini btn--linha", type: "button", onclick: () => recusar(s) }, "Recusar")) });
  const comuns = [
    { rotulo: "Módulos", valor: (s) => s.modulos.map(pfNomeGuia).join(", "), render: (s) => pfChips(s.modulos) },
    { rotulo: "Motivo", valor: (s) => s.motivo },
    { rotulo: "Pedido em", valor: (s) => s.criado_em, render: (s) => pfQuando(s.criado_em) },
    { rotulo: "Situação", valor: (s) => s.situacao, render: pfSituacao },
    { rotulo: "Resolvido por", oculta: true, valor: (s) => s.resolvido_por || "", render: (s) => s.resolvido_por || "—" },
  ];
  corpo.append(
    App.cartao("Pedidos de login", "feitos na tela inicial · ao aprovar, a nova conta abre preenchida",
      App.tabela([
        { rotulo: "Nome", valor: (s) => s.nome, render: (s) => el("b", {}, s.nome) },
        { rotulo: "Contato", valor: (s) => s.contato },
        ...comuns, acoes(aprovarLogin),
      ], lista.filter((s) => s.tipo === "login"), { vazio: "Nenhum pedido de login." })),
    el("div", { style: { height: "16px" } }),
    App.cartao("Pedidos de módulos", "feitos pelas contas no perfil · ao aprovar, os módulos entram na conta",
      App.tabela([
        { rotulo: "Conta", valor: (s) => s.nome, render: (s) => el("b", {}, s.nome) },
        ...comuns, acoes(aprovarModulo),
      ], lista.filter((s) => s.tipo === "modulo"), { vazio: "Nenhum pedido de módulo." })));
}

async function pfLixeira(corpo) {
  const lista = await App.api("/api/lixeira");
  const abertas = lista.filter((x) => !x.restaurado_em);
  corpo.append(App.cartao("Exclusões", `${abertas.length} para desfazer · cada exclusão fica aqui por 90 dias`,
    App.tabela([
      { rotulo: "Excluído em", valor: (x) => x.quando, render: (x) => pfQuando(x.quando) },
      { rotulo: "Por", valor: (x) => x.quem },
      { rotulo: "O quê", valor: (x) => x.resumo, render: (x) => el("b", {}, x.resumo) },
      { rotulo: "IP", oculta: true, valor: (x) => x.ip },
      { rotulo: "Situação", valor: (x) => (x.restaurado_em ? 1 : 0), render: (x) => x.restaurado_em
        ? el("span", { class: "etiqueta etiqueta--ok" }, `Restaurado em ${pfQuando(x.restaurado_em)}`) : el("span", { class: "etiqueta etiqueta--alerta" }, "Excluído") },
      { rotulo: "", fixa: true, render: (x) => x.restaurado_em ? "" : el("button", { class: "btn btn--mini", type: "button", onclick: async () => {
        if (await App.confirmar("Desfazer exclusão", `Restaurar ${x.resumo}?`, "Restaurar")) App.desfazerExclusao(x.grupo);
      } }, "Desfazer") },
    ], lista, { vazio: "Nenhuma exclusão registrada." })));
}
