/* Roteador por hash: #/pagina/param1/param2 */
"use strict";

App.rotear = async function () {
  let [rota = "visao", ...params] = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  // endereços antigos: estas telas agora ficam no perfil (visitante não tem perfil e continua vendo o Catálogo)
  const mudou = { catalogo: "configuracoes/relatorio", "nf/config": "configuracoes/nf", "budget/cadastros": "configuracoes/budget",
    "sup/config": "configuracoes/sup", equipe: "equipe" }[[rota, ...params.slice(0, 1)].join("/")];
  if (mudou && App.temPerfil()) {
    location.replace("#/perfil/" + mudou);
    return;
  }
  App.ajustarEdicao(rota === "catalogo" || !(["nf", "docs", "budget", "sup", "equipe", "perfil"].includes(rota)) ? "relatorio" : rota);
  if ((["cadastro", "dados"].includes(rota) && !App.meta.editavel) || (rota === "equipe" && !App.meta.admin)) {   // visualizador não entra em telas de edição
    location.replace("#/visao");
    return;
  }
  // cada página pertence a uma guia; sem acesso à guia, vai para a primeira liberada
  const guias = (App.meta.acessos || []).length ? App.meta.acessos : ["relatorio"];
  const guiaDa = (r) => (["nf", "docs", "budget", "sup"].includes(r) ? r : ["equipe", "perfil"].includes(r) ? null : "relatorio");
  const inicio = { relatorio: "visao", nf: "nf", docs: "docs", budget: "budget", sup: "sup" };
  if (!App.paginas[rota]) {   // endereço vazio: abre a última área usada (se tiver acesso)
    let ultima = "relatorio";
    try { ultima = localStorage.getItem("rge_area") || "relatorio"; } catch (e) { /* ok */ }
    rota = inicio[guias.includes(ultima) ? ultima : guias[0]] || "visao";
  }
  if (guiaDa(rota) && !guias.includes(guiaDa(rota))) {
    location.replace("#/" + (inicio[guias[0]] || "visao"));
    return;
  }
  const pagina = App.paginas[rota];
  App.ajustarEdicao(guiaDa(rota));   // a rota pode ter virado a última área usada
  App.atualizarMenu(rota, params[0]);
  App.destruirGraficos();
  App._soltar = null;   // arrastar arquivos na página: cada página liga de novo se quiser
  App.antesDeExportar = null;   // a página pode preparar a impressão (ex.: carregar todas as linhas)
  // Excel do botão "Exportar": cada página define o seu (rótulo + url, ou função que devolve a url com os filtros)
  const excelPadrao = {
    visao: ["Base de eventos (Power BI)", "/api/exportar"], evento: ["Base de eventos (Power BI)", "/api/exportar"],
    avarias: ["Base de eventos (Power BI)", "/api/exportar"], manutencao: ["Base de eventos (Power BI)", "/api/exportar"],
    comparar: ["Base de eventos (Power BI)", "/api/exportar"], catalogo: ["Base de eventos (Power BI)", "/api/exportar"],
    docs: ["Documentos", "/api/docs/exportar"],
  }[rota];
  App.exportarExcel = excelPadrao ? { rotulo: excelPadrao[0], url: excelPadrao[1] } : null;
  // telas do Relatório de eventos: Excel da tela (tabelas com filtro + painel com gráficos) e a base do Power BI
  if (["visao", "evento", "avarias", "manutencao", "comparar"].includes(rota)) {
    App.exportarExcel = [
      { titulo: "Excel · relatório desta tela", rotulo: "Painel com gráficos + tabelas com filtro (data, categoria, evento, item…), com os filtros da tela",
        url: () => App.urlExcelTela(rota, params) },
      { titulo: "Excel · base do Power BI", rotulo: "Todas as tabelas do Relatório de eventos (eventos, itens, medidores, chamados…)", url: "/api/exportar" }];
  }
  // tema padrão da rota (evento, manutenção de um evento e comparar ajustam pelo(s) evento(s) em foco)
  App.aplicarTema(["visao", "avarias", "manutencao"].includes(App.paginas[rota] ? rota : "visao") && App.filtroSoJogo());
  // cada navegação escreve no próprio contêiner: resposta atrasada da tela anterior não aparece na tela nova
  const raiz = el("div", { class: "pagina" });
  if (App._rotaAtual !== location.hash) window.scrollTo(0, 0);   // tela nova começa do topo; atualizar a mesma tela mantém a posição
  App._rotaAtual = location.hash;
  App.limpar(document.getElementById("app")).append(raiz, el("div", { class: "esqueleto", "aria-hidden": "true" }, el("i"), el("i"), el("i")));
  try {
    await pagina(raiz, params);
    // arrastar arquivo em qualquer lugar da página: se a página não definiu o seu, usa o importador da área
    if (!App._soltar && App.meta.editavel && App.soltarNaPagina && !(params[0] === "config")) {
      if (["visao", "evento", "avarias", "manutencao", "comparar", "catalogo", "cadastro", "dados"].includes(rota)) {
        App.soltarNaPagina(null, () => App.rotear());   // relatórios de custos de evento ou a base do Power BI
      } else if (["nf", "docs", "budget"].includes(rota)) {
        App.soltarNaPagina(null, () => App.rotear(), { enviar: (files) => App.importacao.importar(files),
          texto: "Planilha de importação (notas fiscais, contratos, pedidos, budget e documentos)" });
      }
    }
    if (["visao", "evento", "avarias", "manutencao", "comparar", "catalogo", "cadastro", "dados", "nf", "docs", "budget", "sup"].includes(rota) && !(["nf", "sup"].includes(rota) && params[0] === "config")) {
      const cab = raiz.querySelector(".pagina-cabecalho");
      if (cab) {
        let ac = cab.querySelector(".acoes");
        if (!ac) { ac = el("div", { class: "acoes" }); cab.append(ac); }
        ac.prepend(App.botaoExportar());
      }
    }
  } catch (e) {
    console.error(e);
    raiz.append(el("div", { class: "cartao vazio" }, el("p", {}, "Não consegui carregar esta página: " + e.message),
      el("button", { class: "btn", type: "button", onclick: () => App.rotear() }, "Tentar de novo")));
  }
  raiz.nextElementSibling?.remove();
  App.organizarAcoes(raiz);
};

(async function iniciar() {
  try {
    App.meta = await App.api("/api/meta");
    document.getElementById("titulo").textContent = App.meta.titulo;
    document.title = App.meta.titulo;
    document.getElementById("setor").textContent = App.meta.setor;
    document.getElementById("btn-cadeado").onclick = App.alternarEdicao;
    if (!App.jaEntrou()) await App.telaEntrada();   // tela inicial: Visitante ou Entrar na conta
    App.atualizarCadeado();
    if ((App.meta.acessos || []).includes("docs")) App.docs.carregar().catch(() => {});   // número de alertas no menu
    await App.carregarEventos();
  } catch (e) {
    document.getElementById("app").append(el("div", { class: "cartao vazio" }, "Não consegui falar com o servidor: " + e.message));
    return;
  }
  window.addEventListener("hashchange", App.rotear);
  // botões Copiar / PNG em todo cartão com gráfico (inclusive os redesenhados por filtros)
  let tf;
  new MutationObserver(() => { clearTimeout(tf); tf = setTimeout(() => App.ferramentasGraficos(document.getElementById("app")), 60); })
    .observe(document.getElementById("app"), { childList: true, subtree: true });
  setInterval(App.atualizarPendentes, 120000);   // admin: número de solicitações na foto do header
  App.realcarArquivos();   // campos de arquivo (janelas de importar / anexar) viram área de arrastar e soltar
  App.rotear();
})();
