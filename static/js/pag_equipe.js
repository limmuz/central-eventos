/* Página: Equipe (contas de quem pode editar + histórico de alterações). Só administrador. */
"use strict";

const NOMES_GUIA = { relatorio: "Relatório de eventos", nf: "Notas fiscais", docs: "Vencimento de documentos", budget: "Budget", sup: "Suprimentos (consumo)" };
const guiasDe = (u) => {
  if (u.perfil === "admin") return Object.keys(App.meta.guias || NOMES_GUIA);
  try { return JSON.parse(u.acessos || '["relatorio"]'); } catch (e) { return ["relatorio"]; }
};

App.paginas.equipe = async function (raiz) {
  const [usuarios, historico] = await Promise.all([App.api("/api/usuarios"), App.api("/api/historico")]);
  const ativos = usuarios.filter((u) => u.ativo);
  raiz.append(
    el("div", { class: "pagina-cabecalho" },
      el("div", {}, el("h2", {}, "Equipe"), el("p", {}, "Contas de quem pode cadastrar e editar pelo próprio computador")),
      el("div", { class: "acoes" }, el("button", { class: "btn", onclick: () => editar({}) }, "+ Nova conta"))),
    el("div", { class: "kpis" },
      App.kpi("Contas ativas", App.fmt.num(ativos.length), "core", `${usuarios.length - ativos.length} desativada(s)`),
      App.kpi("Administradores", App.fmt.num(ativos.filter((u) => u.perfil === "admin").length), "p100", "também gerenciam a equipe"),
      App.kpi("Alterações registradas", App.fmt.num(historico.length), "g200", "últimas 300")),
    el("div", { class: "grade g-12" },
      el("div", { class: "s-12" }, App.cartao("Contas", "clique para editar, trocar a senha ou desativar",
        App.tabela([
          { rotulo: "Nome", valor: (u) => u.nome, render: (u) => el("b", { style: { opacity: u.ativo ? 1 : 0.5 } }, u.nome) },
          { rotulo: "Usuário", valor: (u) => u.login },
          { rotulo: "Perfil", valor: (u) => u.perfil, render: (u) => el("span", { class: "etiqueta" + (u.perfil === "admin" ? "" : " etiqueta--ok") }, u.perfil === "admin" ? "Administrador" : "Editor") },
          { rotulo: "Guias", valor: (u) => guiasDe(u).join(","), render: (u) => el("div", { class: "chips" }, guiasDe(u).map((g) => el("span", { class: "etiqueta" }, NOMES_GUIA[g] || g))) },
          { rotulo: "Situação", valor: (u) => u.ativo, render: (u) => u.ativo ? "Ativa" : el("span", { class: "etiqueta etiqueta--alerta" }, "Desativada") },
          { rotulo: "Último acesso", valor: (u) => u.ultimo_acesso || "", render: (u) => u.ultimo_acesso || "—" },
        ], usuarios, { onClick: editar, vazio: "Nenhuma conta ainda. Crie a primeira em “+ Nova conta”." }),
        el("div", { class: "ajuda", style: { marginTop: "12px", lineHeight: 1.6 } },
          el("b", {}, "Como a equipe entra: "), "abre o site pelo endereço da rede, clica em “Entrar na conta” na tela inicial e usa o usuário e a senha. ",
          "O acesso fica salvo por 30 dias naquele navegador. Quem não tem conta continua só visualizando.",
          el("br"), el("b", {}, "Editor"), " cadastra, anexa e edita dados. ", el("b", {}, "Administrador"), " também cria e desativa contas."))),
      el("div", { class: "s-12" }, App.cartao("Histórico de alterações", "quem fez o quê",
        App.tabela([
          { rotulo: "Quando", valor: (h) => h.quando, render: (h) => h.quando.slice(0, 16).split(" ").map((p, i) => (i ? p : App.fmt.data(p))).join(" ") },
          { rotulo: "Quem", valor: (h) => h.usuario, render: (h) => el("b", {}, h.usuario) },
          { rotulo: "O quê", valor: (h) => h.acao },
          { rotulo: "Detalhe", valor: (h) => h.detalhe },
        ], historico, { vazio: "Nada registrado ainda." })))));

  function editar(u) {
    const novo = !u.id;
    const nome = el("input", { type: "text", value: u.nome || "", placeholder: "Nome completo" });
    const login = el("input", { type: "text", value: u.login || "", placeholder: "ex.: ana.souza", autocomplete: "off" });
    const senha = el("input", { type: "text", placeholder: novo ? "mínimo 6 caracteres" : "deixe vazio para manter", autocomplete: "off" });
    const perfil = el("select", {}, el("option", { value: "editor", selected: u.perfil !== "admin" }, "Editor (cadastra e edita)"),
      el("option", { value: "admin", selected: u.perfil === "admin" }, "Administrador (também gerencia a equipe)"));
    const ativo = el("input", { type: "checkbox", checked: novo || !!u.ativo });
    const atuais = novo ? ["relatorio"] : guiasDe(u);
    const descr = { relatorio: "Visão geral, Evento, Avarias, Manutenção, Comparar, Cadastro e Importar/Exportar", nf: "Medições, contratos, pedidos de compra, gráficos, prazos e configurações das notas fiscais", docs: "Alvará da arena, auditoria interna: vencimentos e histórico de anexos", budget: "Budget por projeto, centro de custo e classe (solicitado, aprovado e incorrido) e cadastros", sup: "Contas de energia elétrica, água e gás: rateio mensal por centro de custo / projeto e planilha de importação do Suprimentos" };
    const todas = { ...NOMES_GUIA, ...(App.meta.guias || {}) };
    const ordem = ["relatorio", "nf", "docs", "budget", "sup", ...Object.keys(todas).filter((g) => !["relatorio", "nf", "docs", "budget", "sup"].includes(g))];
    const caixas = ordem.filter((g) => todas[g]).map((g) => [g, todas[g]]).map(([g, nomeG]) => {
      const c = el("input", { type: "checkbox", value: g, checked: atuais.includes(g) });
      return { g, c, linha: el("label", {}, c, el("span", {}, el("b", {}, nomeG), el("small", { class: "ajuda", style: { display: "block", margin: 0 } }, descr[g] || ""))) };
    });
    const travarAdmin = () => caixas.forEach(({ c }) => { if (perfil.value === "admin") c.checked = true; c.disabled = perfil.value === "admin"; });
    perfil.addEventListener("change", travarAdmin);
    const gerar = el("button", { class: "btn btn--linha btn--mini", onclick: () => {
      const c = "abcdefghjkmnpqrstuvwxyz23456789"; senha.value = Array.from({ length: 8 }, () => c[Math.floor(Math.random() * c.length)]).join("");
    } }, "Gerar senha");
    nome.addEventListener("input", () => {
      if (novo && !login.dataset.mexido) login.value = App.norm(nome.value).trim().split(/\s+/).filter(Boolean).slice(0, 2).join(".").replace(/[^a-z0-9.]/g, "");
    });
    login.addEventListener("input", () => (login.dataset.mexido = "1"));
    const msg = el("p", { class: "ajuda", style: { color: "var(--perigo)", minHeight: "18px" } });
    App.modal(el("div", {}, el("h3", {}, novo ? "Nova conta" : `Conta de ${u.nome}`),
      el("div", { class: "grade", style: { gap: "10px" } },
        el("label", { class: "campo" }, el("span", {}, "Nome"), nome),
        el("label", { class: "campo" }, el("span", {}, "Usuário (para entrar)"), login),
        el("label", { class: "campo" }, el("span", {}, novo ? "Senha" : "Nova senha"), el("div", { style: { display: "flex", gap: "6px" } }, senha, gerar)),
        el("label", { class: "campo" }, el("span", {}, "Perfil"), perfil),
        el("div", { class: "campo" }, el("span", {}, "Guias que a pessoa pode acessar"), el("div", { class: "acessos-lista" }, caixas.map((x) => x.linha)),
          el("small", { class: "ajuda", style: { margin: 0 } }, "Administrador tem acesso a todas. Quem entra como Visitante só vê o Relatório de eventos.")),
        novo ? null : el("label", { style: { display: "flex", gap: "8px", alignItems: "center" } }, ativo, "Conta ativa (desmarque para bloquear o acesso)")),
      el("p", { class: "ajuda" }, "Passe o usuário e a senha para a pessoa. Ela pode trocar a senha depois clicando no próprio nome, no topo do site."),
      msg,
      el("div", { class: "linha-acoes" }, el("button", {
        class: "btn", onclick: async () => {
          try {
            await App.api("/api/usuarios", { method: "POST", json: { id: u.id, nome: nome.value, login: login.value, senha: senha.value, perfil: perfil.value, ativo: ativo.checked, acessos: caixas.filter((x) => x.c.checked).map((x) => x.g) } });
            const credenciais = senha.value ? `Endereço: ${location.origin.replace("localhost", "NOME-DO-SEU-PC")}\nUsuário: ${login.value.trim().toLowerCase()}\nSenha: ${senha.value}` : "";
            App.meta = await App.api("/api/meta"); App.atualizarCadeado();
            App.rotear();
            if (credenciais) {
              const txt = el("textarea", { rows: 4, readonly: true, style: { width: "100%" } }, credenciais);
              App.modal(el("div", {}, el("h3", {}, novo ? "Conta criada" : "Senha alterada"),
                el("p", {}, "Passe estes dados para a pessoa (a senha não aparece de novo depois):"), txt,
                el("div", { class: "linha-acoes" },
                  el("button", { class: "btn", onclick: async () => { try { await navigator.clipboard.writeText(credenciais); App.toast("Copiado."); } catch (e) { txt.select(); document.execCommand("copy"); App.toast("Copiado."); } } }, "Copiar"),
                  el("button", { class: "btn btn--linha", "data-fechar": "" }, "Fechar"))));
            } else {
              App.fecharModal();
              App.toast("Conta atualizada.");
            }
          } catch (e) { msg.textContent = e.message; }
        },
      }, "Salvar"), el("button", { class: "btn btn--linha", "data-fechar": "" }, "Cancelar"))));
    travarAdmin();
  }
};
