/* Página: Importar / Exportar */
"use strict";

App.paginas.dados = async function (raiz) {
  const ro = !App.meta.editavel;
  const input = el("input", { type: "file", accept: ".xlsm,.xlsx", hidden: true });
  const subst = el("input", { type: "checkbox", checked: true });
  const zona = el("div", { class: "soltar" },
    el("div", {}, el("b", {}, "Clique ou arraste"), " a planilha aqui"),
    el("div", { class: "ajuda" }, "Aceita a planilha de importação (exemplo), o Excel exportado por este site ou a planilha antiga do Power BI. Pode mandar só as abas que quiser (ex.: só ITENS com as avarias): o que não vier na planilha não é apagado."));
  const resultado = el("div", { style: { marginTop: "12px" } });
  const enviar = async (f) => {
    if (!f) return;
    const fd = new FormData();
    fd.append("arquivo", f);
    fd.append("substituir", subst.checked ? "1" : "0");
    zona.classList.add("carregando");
    App.limpar(resultado).append(el("p", { class: "ajuda" }, "Importando… isso pode levar alguns segundos."));
    try {
      const r = await App.api("/api/importar", { method: "POST", body: fd });
      App.limpar(resultado).append(el("div", { class: "kpis" },
        App.kpi("Eventos novos", App.fmt.num(r.eventos_novos), "core"),
        App.kpi("Itens", App.fmt.num(r.itens), "p100", `avarias ${App.fmt.num(r.avarias || 0)} · MDO ${App.fmt.num(r.mdo || 0)} · insumos ${App.fmt.num(r.insumos || 0)}`),
        App.kpi("Medidores", App.fmt.num(r.relogios), "g200"),
        App.kpi("Chamados", App.fmt.num(r.chamados), "p100"),
        App.kpi("Energia (horas)", App.fmt.num(r.energia_hora), "p100"),
        App.kpi("Catálogo", App.fmt.num(r.catalogo), "p100")),
        r.ignoradas ? el("p", { class: "ajuda", style: { color: "var(--perigo)" } }, `${r.ignoradas} linha(s) sem data válida foram ignoradas (use dd/mm/aaaa na coluna DATA).`) : null,
        !(r.eventos_novos || r.itens || r.relogios || r.chamados || r.energia_hora || r.catalogo)
          ? el("p", { class: "ajuda", style: { color: "var(--perigo)" } }, "Nada foi lido. Confira se a aba se chama EVENTOS, ITENS, MEDIDORES, CHAMADOS, ENERGIA ou CATALOGO e se o cabeçalho (EVENTO, DATA, TIPO, ITEM...) está como na planilha de exemplo.") : null);
      App.chamados = null; App.catalogo = null;
      await App.carregarEventos(); App.meta = await App.api("/api/meta");
      App.toast("Importação concluída.");
    } catch (e) { App.limpar(resultado); App.toast(e.message, true); }
    zona.classList.remove("carregando");
  };
  zona.onclick = () => input.click();
  input.onchange = () => enviar(input.files[0]);
  zona.addEventListener("dragover", (ev) => { ev.preventDefault(); zona.classList.add("sobre"); });
  zona.addEventListener("dragleave", () => zona.classList.remove("sobre"));
  zona.addEventListener("drop", (ev) => { ev.preventDefault(); zona.classList.remove("sobre"); enviar(ev.dataTransfer.files[0]); });

  const nEv = App.eventos.length, nIt = App.soma(App.eventos, (e) => e.n_itens), nCh = App.soma(App.eventos, (e) => e.n_chamados);
  raiz.append(
    el("div", { class: "pagina-cabecalho" },
      el("div", {}, el("h2", {}, "Importar / Exportar"), el("p", {}, `Base atual: ${nEv} eventos · ${App.fmt.num(nIt)} itens · ${App.fmt.num(nCh)} chamados`))),
    el("div", { class: "grade g-2" },
      App.cartao("Exportar Excel (base do Power BI)", "novo modelo, organizado em tabelas",
        el("p", {}, "Gera um .xlsx com as tabelas tbEventos, tbItens, tbMedidores, tbChamados, tbEnergia e tbCatalogo, já com os totais calculados."),
        el("p", { class: "ajuda" }, "Salve o arquivo sempre no mesmo lugar (com o mesmo nome) e aponte o Power BI para ele. Para atualizar o painel: exportar → salvar por cima → Atualizar no Power BI."),
        el("div", { class: "linha-acoes" }, el("a", { class: "btn", href: "/api/exportar" }, "Exportar Excel"))),
      el("div", { class: ro ? "cartao" : "cartao" },
        el("div", { class: "cartao__titulo" }, el("h3", {}, "Importar planilha", App.botaoAjuda("Carrega vários eventos de uma vez a partir da planilha de importação (abas EVENTOS, ITENS, MEDIDORES, CHAMADOS, ENERGIA e CATALOGO). Use para a carga inicial ou para corrigir muitos eventos de uma vez. Baixe o exemplo para ver o formato de cada aba.", "Importar planilha")), el("span", { class: "sub" }, "carga inicial ou atualização em massa"),
          el("a", { class: "btn btn--linha btn--mini", href: "/api/modelo-importacao", style: { marginLeft: "auto" },
            title: "Planilha de exemplo com as abas EVENTOS, ITENS, MEDIDORES, CHAMADOS, ENERGIA e CATALOGO" }, "Baixar planilha de importação (exemplo)")),
        ro ? el("p", { class: "ajuda" }, "Disponível apenas no modo edição.") : el("div", {}, input, zona,
          el("label", { style: { display: "flex", gap: "8px", alignItems: "center", marginTop: "10px" } }, subst,
            el("span", {}, "Substituir os dados dos eventos que estão na planilha (recomendado, evita duplicar)")),
          resultado))),
    ro ? null : el("div", { class: "grade", style: { marginTop: "16px" } },
      App.cartao("Reorganizar planilhas anexadas", "confere todos os anexos de uma vez",
        el("p", {}, "Lê o nome e a data (C5/C6) de cada planilha anexada, move para o evento certo, junta eventos que foram criados em duplicidade, remove anexos repetidos e puxa os dados de novo."),
        el("p", { class: "ajuda" }, "Planilhas cujo nome do arquivo tem uma data diferente de C6 são só movidas (os valores não são puxados) e aparecem na lista para você conferir."),
        el("div", { class: "linha-acoes" }, el("button", {
          class: "btn btn--sec", onclick: async (ev) => {
            if (!(await App.confirmar("Reorganizar anexos", "Conferir todas as planilhas anexadas e corrigir eventos duplicados?", "Reorganizar"))) return;
            try {
              const r = await App.api("/api/anexos/reorganizar", { method: "POST" });
              App.chamados = null; await App.carregarEventos();
              const bloco = (t, l) => l.length ? el("div", { style: { marginBottom: "10px" } }, el("b", {}, t), el("ul", { style: { margin: "4px 0 0", paddingLeft: "18px" } }, l.map((x) => el("li", {}, x)))) : null;
              App.modal(el("div", {}, el("h3", {}, "Anexos reorganizados"),
                el("p", {}, `${r.reaplicados} planilhas tiveram os dados puxados de novo · ${r.repetidos_removidos} anexo(s) repetido(s) removido(s).`),
                bloco("Movidas para o evento certo", r.movidos),
                bloco("Eventos duplicados removidos", r.eventos_removidos),
                bloco("Conferir (valores não puxados)", r.conflitos),
                bloco("Sem evento correspondente", r.sem_evento),
                el("div", { class: "linha-acoes" }, el("button", { class: "btn", "data-fechar": "", onclick: () => App.rotear() }, "OK"))));
            } catch (err) { App.toast(err.message, true); }
          },
        }, "Reorganizar anexos")))),
    ro ? null : el("div", { class: "grade", style: { marginTop: "16px" } },
      App.cartao("Anexar relatórios de custos por evento", "Custos - Engenharia - EVENTO dd-mm-aa.xlsx",
        App.zonaAnexoAutomatico(() => App.rotear()))),
    el("div", { class: "grade", style: { marginTop: "16px" } },
      App.cartao("Como ligar o Power BI no novo Excel", "",
        el("ol", { style: { margin: 0, paddingLeft: "18px", lineHeight: 1.7 } },
          el("li", {}, "Exporte o Excel aqui e salve, por exemplo, em uma pasta da rede (ex.: BASE POWER BI.xlsx)."),
          el("li", {}, "No Power BI: Página Inicial › Transformar dados › Configurações da fonte de dados › Alterar fonte, e escolha o novo arquivo."),
          el("li", {}, "Troque as consultas antigas pelas tabelas novas: INFOS → tbItens, RELÓGIOS_VALOR → tbMedidores, CHAMADOS → tbChamados, TOTAL_GERAL → tbEventos, TABELA_ENERGIA_HORA → tbEnergia."),
          el("li", {}, "Relacione as tabelas pela coluna ID EVENTO (tbEventos 1 → N nas demais). O rótulo \u201cEVENTO - DATA\u201d pode ser uma coluna calculada: [EVENTO] & \" - \" & FORMAT([DATA], \"dd/mm/yyyy\")."),
          el("li", {}, "Os totais de MDO, avarias, medidores e chamados já vêm prontos na tbEventos, o que dispensa a maioria das medidas antigas.")))));
};
