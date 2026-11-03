/* Página: Evento (overview de engenharia de um dia de evento). */
"use strict";

App.paginas.evento = async function (raiz, params) {
  let id = params[0] ? +params[0] : null;
  if (!id) {
    try { id = +localStorage.getItem("rge_evento") || null; } catch (e) { /* ok */ }
  }
  if (!id || !App.eventos.find((e) => e.id === id)) id = App.eventos.find((e) => e.total > 0)?.id || App.eventos[0]?.id;
  App.aplicarTema(App.ehJogo(App.eventos.find((e) => e.id === id)));

  const seletor = App.seletorEvento({
    valor: App.eventos.find((e) => e.id === id),
    placeholder: "Buscar evento por nome ou data…",
    onSelect: (e) => e && (location.hash = `#/evento/${e.id}`),
  });
  const corpo = el("div");
  const btnSoltar = App.btnEditor("Enviar planilhas", () => App.modal(el("div", {}, el("h3", {}, "Enviar planilhas"),
    App.zonaAnexoAutomatico(() => App.rotear()))), "btn btn--sec");
  btnSoltar.title = "Relatórios de custos de qualquer evento ou a base do Power BI. Também dá para arrastar os arquivos direto nesta página.";
  raiz.append(
    el("div", { class: "pagina-cabecalho" },
      el("div", {}, el("h2", {}, "Evento"), el("p", {}, "Overview de engenharia de um dia de evento")),
      el("div", { class: "acoes" }, App.importacao.botoesRelatorio(), btnSoltar)),
    App.barraPadrao({ campos: [el("label", { class: "campo campo--cresce" }, el("span", {}, "Evento"), seletor)] }),
    corpo);
  App.soltarNaPagina(raiz, () => App.rotear());
  if (!id) { corpo.append(el("div", { class: "cartao vazio" }, "Nenhum evento cadastrado ainda. Use Cadastro ou Importar.")); return; }
  try { localStorage.setItem("rge_evento", id); } catch (e) { /* ok */ }

  const e = await App.api(`/api/eventos/${id}`);
  const R = App.cores.relogio, C = App.cores.componente;
  /* ---- topo */
  corpo.append(App.cabecalhoEvento(e, {
    rota: "evento",
    acoes: [
      App.btnEditor("Anexar planilha", () => App.modal(el("div", {}, el("h3", {}, `Anexar planilha · ${e.nome} ${App.fmt.dataCurta(e.data)}`),
        App.zonaAnexoEvento(e, () => App.rotear()))), "btn btn--linha"),
      App.btnEditor("Editar dados", () => (location.hash = `#/cadastro/${e.id}`), "btn btn--linha")],
  }));

  /* ---- KPIs (mesma ordem do relatório original) */
  corpo.append(el("div", { class: "kpis" },
    App.kpi("Água", App.fmt.brlCurto(e.agua), "p100", e.irrigacao || e.irrigacao_consumo
      ? el("span", {}, consumo(e, "ÁGUA", "m³"), el("br"), `dos quais irrigação do gramado ${App.fmt.brlCurto(e.irrigacao)}${e.irrigacao_consumo ? ` · ${App.fmt.num(e.irrigacao_consumo)} m³` : ""}`)
      : consumo(e, "ÁGUA", "m³")),
    App.kpi("Energia elétrica", App.fmt.brlCurto(e.eletrica), "p100", consumo(e, "ELÉTRICA", "kWh")),
    App.kpi("Gás", App.fmt.brlCurto(e.gas), "p100", consumo(e, "GÁS", "m³")),
    App.kpi("Poço artesiano", App.fmt.brlCurto(e.poco), "g200", consumo(e, "POÇO", "m³")),
    App.kpi("Técnicos transporte vertical", App.fmt.num(e.tecnicos_tv), "p900", `MDO · ${App.fmt.brlCurto(e.tecnicos_tv_valor)}`),
    App.kpi("Técnico de medição acústica", App.fmt.num(e.acustica), "p900", `MDO · ${App.fmt.brlCurto(e.acustica_valor)}`),
    App.kpi("Custo total", App.fmt.brlCurto(e.total), "core", `MDO ${App.fmt.brlCurto(e.mdo)} · Avarias ${App.fmt.brlCurto(e.avarias)}`)));

  /* ---- composição + energia por hora */
  const partes = [
    ["Energia", e.eletrica, R["ELÉTRICA"]], ["Água", e.agua, R["ÁGUA"]], ["Gás", e.gas, R["GÁS"]], ["Poço", e.poco, R["POÇO"]],
    ["MDO", e.mdo, C.MDO], ["Avarias", e.avarias, C.AVARIAS], ...(e.insumos ? [["Insumos", e.insumos, C.INSUMOS]] : []),
  ];
  const aC = G.area("grafico");
  aC.div.style.height = (partes.length * 40 + 40) + "px";
  const aE = G.area("grafico");
  const cartaoEnergia = e.energia.length
    ? App.cartao("Energia por hora", `kWh · ${e.energia[0]?.hora || ""} até ${e.energia[e.energia.length - 1]?.hora || ""}`, aE.div)
    : App.cartao("Energia por hora", "", el("div", { class: "vazio" }, "Sem curva de energia para este evento."));
  corpo.append(el("div", { class: "grade g-12" },
    el("div", { class: "s-5" }, App.cartao("Composição do custo", `${e.nome} · ${App.fmt.data(e.data)} · total ${App.fmt.brl(e.total)}`, aC.div)),
    el("div", { class: "s-7" }, cartaoEnergia)));
  G.barrasH(aC.canvas, partes.map((p) => p[0]), partes.map((p) => p[1]), partes.map((p) => p[2]),
    { fmt: (v) => App.fmt.brl(v), tooltipExtra: (i) => ` ${App.fmt.pct(e.total ? 100 * partes[i][1] / e.total : 0)} do total` });
  if (e.energia.length) {
    G.linha(aE.canvas, e.energia.map((h) => h.hora), [{ rotulo: "kWh", cor: App.cores.core, valores: e.energia.map((h) => h.consumo), area: true }],
      { fmt: (v) => App.fmt.num(v) + " kWh" });
  }

  /* ---- chamados (resumo) + comparação com média da categoria */
  const tempos = e.chamados.map((c) => c.tempo).filter((t) => t !== null);
  const porTipo = Object.entries(App.agrupar(e.chamados, (c) => c.tipo || "SEM TIPO")).sort((a, b) => b[1].length - a[1].length);
  const mesmos = App.eventos.filter((x) => x.categoria === e.categoria && x.total > 0 && x.id !== e.id);
  const mediaCat = App.media(mesmos, (x) => x.total);
  const dif = mediaCat ? 100 * (e.total - mediaCat) / mediaCat : null;
  corpo.append(el("div", { class: "grade g-12", style: { marginTop: "16px" } },
    el("div", { class: "s-6" }, App.cartao("Chamados de manutenção", `${e.chamados.length} chamados`,
      e.chamados.length ? el("div", {},
        el("div", { class: "kpis" },
          App.kpi("Tempo médio", App.fmt.min(e.tempo_medio) + " min", "branco"),
          App.kpi("Dentro do SLA", App.fmt.pct(e.pct_sla), "branco"),
          App.kpi("Tempo máximo", App.fmt.min(tempos.length ? Math.max(...tempos) : null), "branco")),
        el("div", { class: "chips" }, porTipo.map(([t, l]) => el("span", { class: "etiqueta" }, `${t} (${l.length})`))),
        el("div", { class: "linha-acoes" }, el("a", { class: "btn btn--sec btn--mini", href: `#/manutencao/${e.id}` }, "Ver na página de manutenção")))
        : el("div", { class: "vazio" }, "Nenhum chamado registrado."))),
    el("div", { class: "s-6" }, App.cartao(`Comparado à média de ${e.categoria || "eventos"}`, `${mesmos.length} outros eventos da categoria`,
      mediaCat ? el("div", { class: "kpis", style: { marginBottom: 0 } },
        App.kpi("Este evento", App.fmt.brlCurto(e.total), "p100"),
        App.kpi("Média da categoria", App.fmt.brlCurto(mediaCat), "branco"),
        App.kpi("Diferença", (dif > 0 ? "+" : "") + App.fmt.pct(dif), dif > 0 ? "p900" : "g200", dif > 0 ? "acima da média" : "abaixo da média"))
        : el("div", { class: "vazio" }, "Sem eventos suficientes para comparar.")))));

  /* ---- itens */
  corpo.append(el("div", { class: "grade", style: { marginTop: "16px" } },
    App.cartao("Itens de custo", `${e.itens.length} itens · avarias, MDO e insumos`,
      App.tabela([
        { rotulo: "Tipo", valor: (i) => i.tipo, render: (i) => el("span", { class: "etiqueta" }, el("i", { style: { background: C[i.tipo] || C.AVARIAS } }), i.tipo) },
        { rotulo: "Item", valor: (i) => i.item },
        { rotulo: "Valor unit.", num: true, valor: (i) => i.valor_unit, render: (i) => App.fmt.brl(i.valor_unit) },
        { rotulo: "Qtd.", num: true, valor: (i) => i.qtd, render: (i) => App.fmt.num(i.qtd), total: (l) => App.fmt.num(App.soma(l, (i) => i.qtd)) },
        { rotulo: "Total", num: true, valor: (i) => i.total, render: (i) => el("b", {}, App.fmt.brl(i.total)), total: (l) => App.fmt.brl(App.soma(l, (i) => i.total)) },
      ], e.itens, { rodape: true, vazio: "Nenhum item lançado." }))));

  /* ---- anexos */
  if (e.anexos.length) {
    corpo.append(el("div", { class: "secao" }, el("h3", {}, "Planilhas deste evento")),
      el("div", { class: "grade" }, App.blocoAnexos(e, () => App.rotear(), { comZona: false })));
  }

  function consumo(ev, tipo, un) {
    const r = ev.relogios_lista.find((x) => x.tipo === tipo);
    return r ? el("span", { class: "kpi__consumo" }, `${App.fmt.num(r.consumo)} ${un}`, el("small", {}, " consumidos")) : "sem leitura";
  }
};

/** Cabeçalho escuro do evento (nome, data, categoria, público, cliente, outros dias).
 *  Usado em Evento, Manutenção e Avarias. opcoes.rota = página para onde levam os links de "outro dia". */
App.cabecalhoEvento = function (e, opcoes = {}) {
  const rota = opcoes.rota || "evento";
  const outrosDias = App.eventos.filter((x) => x.nome === e.nome && x.id !== e.id).sort((a, b) => a.data.localeCompare(b.data));
  const btnComparar = outrosDias.length
    ? el("a", { class: "btn btn--linha", href: `#/comparar/${e.id}/${outrosDias[outrosDias.length - 1].id}` }, `Comparar com outro dia (${outrosDias.length})`)
    : null;
  const btnAbrir = rota !== "evento" ? el("a", { class: "btn btn--linha", href: `#/evento/${e.id}` }, "Abrir evento") : null;
  return el("div", { class: "evento-topo" },
    el("div", {},
      el("span", { class: "antetitulo" }, `${App.fmt.data(e.data)}${e.horario ? " · " + e.horario : ""}`),
      el("h2", {}, e.nome),
      el("div", { class: "meta" },
        el("span", { class: "etiqueta" }, el("i", { style: { background: App.corCategoria(e.categoria) } }), e.categoria || "Sem categoria"),
        e.genero ? el("span", { class: "etiqueta" }, e.genero) : null,
        e.publico ? el("span", { class: "etiqueta" }, `Público: ${App.fmt.num(e.publico)}`) : null,
        e.cliente ? el("span", { class: "etiqueta" }, `Cliente: ${e.cliente}`) : null,
        outrosDias.map((o) => el("a", { class: "etiqueta", href: `#/${rota}/${o.id}`, style: { textDecoration: "none" } }, `Outro dia: ${App.fmt.dataCurta(o.data)}`)))),
    el("div", { class: "acoes" }, btnAbrir, btnComparar, opcoes.acoes || null));
};

/** Arrastar planilhas em qualquer lugar da página (só para quem pode editar).
 *  Vale só para a página que chamou: o roteador desliga (App._soltar = null) ao trocar de página. */
App.soltarNaPagina = function (_alvo, aoMudar, opcoes = {}) {
  App._soltar = App.meta.editavel ? aoMudar : null;
  App._soltarEnviar = opcoes.enviar || ((files, cb) => App.enviarAutomatico(files, cb));
  App._soltarTexto = opcoes.texto || "Relatórios de custos de evento ou a base do Power BI (só entra o que ainda não está cadastrado)";
  if (App._soltarInstalado) return;
  App._soltarInstalado = true;
  const textoAviso = el("div");
  const aviso = el("div", { class: "soltar-pagina" }, el("div", {}, el("b", {}, "Solte para enviar"), textoAviso));
  let n = 0;
  const ativo = (ev) => App._soltar && App.meta.editavel && [...(ev.dataTransfer?.types || [])].includes("Files") && document.getElementById("modal").hidden;
  document.addEventListener("dragenter", (ev) => { if (!ativo(ev)) return; n++; textoAviso.textContent = App._soltarTexto; if (!aviso.isConnected) document.body.append(aviso); });
  document.addEventListener("dragleave", () => { if (--n <= 0) { n = 0; aviso.remove(); } });
  document.addEventListener("dragover", (ev) => { if (ativo(ev)) ev.preventDefault(); });
  document.addEventListener("drop", (ev) => {
    n = 0; aviso.remove();
    if (!ativo(ev) || ev.target.closest(".soltar")) return;   // as zonas próprias tratam o drop
    ev.preventDefault();
    App._soltarEnviar(ev.dataTransfer.files, App._soltar);
  });
};

/* Bloco de anexos (usado no Evento e no Cadastro) */
App.zonaAnexoEvento = function (e, aoMudar) {
  const input = el("input", { type: "file", multiple: true, hidden: true, accept: ".xlsx,.xlsm,.xls,.pdf,.csv,.docx,.png,.jpg" });
  const zona = el("div", { class: "soltar so-editor" },
    el("div", {}, el("b", {}, "Clique ou arraste"), " planilhas do evento aqui (ex.: Custos - Engenharia - ", e.nome, ".xlsx)"),
    el("div", { class: "ajuda" }, "O arquivo fica guardado no evento. Relatórios de custos (abas Consumo e CHAMADOS CCO) já gravam público, horário, medidores, energia por hora e chamados."));
  if (!App.meta.editavel) zona.setAttribute("data-bloqueado", "");
  const enviar = async (files) => {
    if (!files.length) return;
    zona.classList.add("carregando");
    const resultados = await App.enviarArquivos(`/api/eventos/${e.id}/anexos`, files);
    App.chamados = null;
    try { await App.carregarEventos(); } catch (err) { /* servidor fora */ }
    App.mostrarResultadosAnexo(resultados, aoMudar);
    zona.classList.remove("carregando");
  };
  zona.onclick = () => input.click();
  input.onchange = () => enviar(input.files);
  zona.addEventListener("dragover", (ev) => { ev.preventDefault(); zona.classList.add("sobre"); });
  zona.addEventListener("dragleave", () => zona.classList.remove("sobre"));
  zona.addEventListener("drop", (ev) => { ev.preventDefault(); zona.classList.remove("sobre"); enviar(ev.dataTransfer.files); });

  return el("div", {}, input, zona);
};

App.blocoAnexos = function (e, aoMudar, { comZona = true } = {}) {
  const zona = comZona ? App.zonaAnexoEvento(e, aoMudar) : null;
  const lista = e.anexos.map((a) => {
    const ext = (a.nome_original.split(".").pop() || "").toUpperCase().slice(0, 4);
    const r = a.resumo;
    return el("div", { class: "anexo" },
      el("div", { class: "anexo__topo" },
        el("div", { class: "icone" }, ext),
        el("div", {}, el("b", {}, a.nome_original), el("small", {}, `${(a.tamanho / 1024).toFixed(0)} KB · enviado em ${a.enviado_em}`
          + (r && r.versao ? ` · modelo ${r.versao}` : ""))),
        el("div", { class: "acoes" },
          el("a", { class: "btn btn--sec btn--mini", href: `/api/anexos/${a.id}/download` }, "Baixar"),
          /\.xls[xm]?$/i.test(a.nome_original) ? App.btnEditor("Puxar medidores e chamados", () => App.importarDoAnexo(a, aoMudar), "btn btn--linha btn--mini") : null,
          App.btnEditor("Excluir", async () => {
            if (!(await App.confirmar("Excluir anexo", `Excluir "${a.nome_original}"?`, "Excluir"))) return;
            await App.api(`/api/anexos/${a.id}`, { method: "DELETE" });
            aoMudar();
          }, "btn btn--perigo btn--mini"))),
      r && r.grupos && r.grupos.length ? el("div", {},
        el("div", { class: "totais-anexo" }, (r.totais || []).map((t) => el("span", { class: "etiqueta etiqueta--ok" }, `${t.rotulo}: ${App.fmt.brl(t.valor)}`))),
        el("div", { class: "resumo-anexo", style: { marginTop: "10px" } }, r.grupos.map((g) =>
          el("div", { class: "grupo" }, el("h4", {}, g.titulo),
            g.linhas.map((l) => el("div", {}, el("span", {}, [l.servico, l.empresa].filter(Boolean).join(" · ") + (l.qtd ? ` (${l.qtd})` : "")), el("span", {}, App.fmt.brl(l.valor)))),
            g.subtotal !== undefined ? el("div", { class: "sub" }, el("span", {}, "Subtotal"), el("span", {}, App.fmt.brl(g.subtotal))) : null))))
        : null);
  });
  return App.cartao("Planilhas anexadas", `${e.anexos.length} arquivo(s)`, zona,
    el("div", { class: "grade", style: { marginTop: "12px" } }, lista.length ? lista : el("div", { class: "vazio" }, "Nenhum arquivo anexado.")));
};

/* Lê as abas Consumo / CHAMADOS CCO do anexo e grava no evento */
App.importarDoAnexo = async function (a, aoMudar) {
  let d;
  try { d = await App.api(`/api/anexos/${a.id}/dados`); } catch (e) { App.toast(e.message, true); return; }
  const opcoes = [
    ["relogios", `Medidores de consumo (${d.relogios.length})`, d.relogios.map((r) => `${r.tipo}: ${App.fmt.num(r.consumo)} · ${App.fmt.brl(r.valor)}`).join("  |  ")],
    ["energia", `Energia por hora (${d.energia.length} horas)`, d.energia.length ? `${d.energia[0].hora} → ${d.energia[d.energia.length - 1].hora}` : ""],
    ["chamados", `Chamados do CCO (${d.chamados.length})`, d.chamados.slice(0, 3).map((c) => c.descricao).join(" · ") + (d.chamados.length > 3 ? " …" : "")],
  ];
  const caixas = {};
  const corpo = el("div", {},
    el("h3", {}, "Puxar dados da planilha"),
    el("p", { class: "ajuda" }, `Arquivo: ${a.nome_original}. Os dados marcados substituem os atuais do evento.`),
    ...opcoes.map(([k, rot, det]) => {
      const n = d[k].length;
      caixas[k] = el("input", { type: "checkbox", checked: n > 0, disabled: n === 0 });
      return el("label", { style: { display: "flex", gap: "10px", alignItems: "flex-start", padding: "10px 0", borderBottom: "1px solid var(--linha)" } },
        caixas[k], el("div", {}, el("b", {}, rot), el("div", { class: "ajuda" }, n ? det : "não encontrado nesta planilha")));
    }),
    el("div", { class: "linha-acoes" },
      el("button", {
        class: "btn", onclick: async () => {
          const op = Object.fromEntries(Object.entries(caixas).map(([k, c]) => [k, c.checked]));
          try {
            const r = await App.api(`/api/anexos/${a.id}/aplicar`, { method: "POST", json: op });
            App.fecharModal();
            App.toast("Dados gravados: " + Object.entries(r).map(([k, v]) => `${v} ${k}`).join(", "));
            App.chamados = null;
            await App.carregarEventos();
            aoMudar();
          } catch (e) { App.toast(e.message, true); }
        },
      }, "Gravar no evento"),
      el("button", { class: "btn btn--linha", "data-fechar": "" }, "Cancelar")));
  App.modal(corpo);
};

/* Resumo do que aconteceu ao anexar (usado no evento, no cadastro e no anexo automático) */
App.mostrarResultadosAnexo = function (resultados, aoFechar) {
  const temAviso = resultados.some((r) => r.erro || (r.avisos && r.avisos.length) || r.criado || r.base);
  const linhas = resultados.map((r) => {
    if (r.base && r.resumo) return App.resumoBase(r);
    const p = r.puxado || {};
    const partes = [p.relogios && `${p.relogios} medidores`, p.energia && `${p.energia} horas de energia`, p.chamados && `${p.chamados} chamados`].filter(Boolean);
    return el("div", { class: "anexo", style: { marginBottom: "8px" } },
      el("div", {}, el("b", {}, r.arquivo || ""),
        r.evento ? el("div", { class: "ajuda" }, `${r.criado ? "Evento novo criado: " : "Evento: "}${r.evento} · ${App.fmt.data(r.data)}`
          + (r.como && r.como !== "nome e data" ? ` (encontrado pela ${r.como})` : "")) : null),
      r.versao ? el("div", { class: "ajuda", style: { marginTop: 0 } }, `Modelo de planilha: ${r.versao}`) : null,
      r.erro ? el("span", { class: "etiqueta etiqueta--alerta" }, r.erro) :
        el("div", { class: "chips" }, partes.length ? partes.map((t) => el("span", { class: "etiqueta etiqueta--ok" }, t)) : el("span", { class: "etiqueta" }, "Arquivo guardado (nada para puxar)")),
      (r.avisos || []).map((a) => el("div", { class: "etiqueta etiqueta--alerta", style: { height: "auto", padding: "6px 10px", whiteSpace: "normal" } }, a)),
      r.evento_id ? el("a", { class: "btn btn--sec btn--mini", href: `#/evento/${r.evento_id}`, "data-fechar": "" }, "Abrir evento") : null);
  });
  if (!temAviso && resultados.length === 1) {
    App.fecharModal();
    const p = resultados[0].puxado || {};
    App.toast("Anexado" + (p.chamados || p.relogios ? ` · ${p.relogios || 0} medidores, ${p.energia || 0} h de energia, ${p.chamados || 0} chamados` : "."));
    if (aoFechar) aoFechar();
    return;
  }
  App.modal(el("div", {}, el("h3", {}, "Planilhas anexadas"), ...linhas,
    el("div", { class: "linha-acoes" }, el("button", { class: "btn", onclick: () => { App.fecharModal(); if (aoFechar) aoFechar(); } }, "OK"))));
};

/** Resultado de quando soltam a base do Power BI: o que entrou e o que já existia (não foi mexido). */
App.resumoBase = function (r) {
  const s = r.resumo, pre = s.preenchidos || {}, pul = s.pulados || {};
  const ok = (t) => el("span", { class: "etiqueta etiqueta--ok" }, t);
  const neutro = (t) => el("span", { class: "etiqueta" }, t);
  const novos = [
    s.avarias && ok(`${App.fmt.num(s.avarias)} avarias em ${pre.AVARIAS || 0} evento(s)`),
    s.mdo && ok(`${App.fmt.num(s.mdo)} itens de MDO em ${pre.MDO || 0} evento(s)`),
    s.insumos && ok(`${App.fmt.num(s.insumos)} insumos em ${pre.INSUMOS || 0} evento(s)`),
    s.relogios && ok(`${App.fmt.num(s.relogios)} medidores`),
    s.chamados && ok(`${App.fmt.num(s.chamados)} chamados em ${pre.chamados || 0} evento(s)`),
    s.energia_hora && ok(`${App.fmt.num(s.energia_hora)} horas de energia`),
    s.eventos_novos && ok(`${s.eventos_novos} evento(s) novo(s) criado(s)`),
  ].filter(Boolean);
  const mantidos = [
    pul.AVARIAS && neutro(`${pul.AVARIAS} evento(s) já tinham avarias`),
    pul.MDO && neutro(`${pul.MDO} já tinham MDO`),
    pul.INSUMOS && neutro(`${pul.INSUMOS} já tinham insumos`),
    pul.chamados && neutro(`${pul.chamados} já tinham chamados`),
  ].filter(Boolean);
  return el("div", { class: "anexo", style: { marginBottom: "8px" } },
    el("div", {}, el("b", {}, r.arquivo || ""), el("div", { class: "ajuda" }, "Base do Power BI · só entrou o que ainda não estava cadastrado")),
    el("div", { class: "chips" }, novos.length ? novos : neutro("Nada novo: tudo o que está na planilha já estava no site")),
    mantidos.length ? el("div", { class: "ajuda", style: { marginTop: "6px" } }, "Mantidos como estavam (não duplicados):") : null,
    mantidos.length ? el("div", { class: "chips" }, mantidos) : null);
};

/** Envia planilhas sem escolher o evento: relatórios de custos (lê C5/C6) ou a base do Power BI. */
App.enviarAutomatico = async function (files, aoMudar, zona = null) {
  if (!files || !files.length) return;
  if (zona) zona.classList.add("carregando");
  App.toast("Enviando…");
  const resultados = await App.enviarArquivos("/api/anexos/auto", files);
  App.chamados = null; App.avarias = null;
  try { await App.carregarEventos(); App.meta = await App.api("/api/meta"); } catch (err) { /* servidor fora */ }
  App.mostrarResultadosAnexo(resultados, aoMudar);
  if (zona) zona.classList.remove("carregando");
};

/* Zona para anexar relatórios sem escolher o evento (o site lê C5/C6 da aba Consumo) */
App.zonaAnexoAutomatico = function (aoMudar) {
  const input = el("input", { type: "file", multiple: true, hidden: true, accept: ".xlsx,.xlsm,.xls" });
  const zona = el("div", { class: "soltar" },
    el("div", {}, el("b", {}, "Clique ou arraste"), " os relatórios de custos dos eventos (um ou vários) ou a base do Power BI"),
    el("div", { class: "ajuda" }, "Relatório de custos: o site lê o nome (C5) e a data (C6) da aba Consumo, encontra ou cria o evento, guarda o arquivo e puxa medidores, energia por hora e chamados. "
      + "Base do Power BI: entram avarias, MDO, insumos, chamados e medidores só dos eventos que ainda não têm esses dados — o que já está cadastrado não é duplicado nem alterado."));
  const enviar = (files) => App.enviarAutomatico(files, aoMudar, zona);
  zona.onclick = () => input.click();
  input.onchange = () => enviar(input.files);
  zona.addEventListener("dragover", (ev) => { ev.preventDefault(); zona.classList.add("sobre"); });
  zona.addEventListener("dragleave", () => zona.classList.remove("sobre"));
  zona.addEventListener("drop", (ev) => { ev.preventDefault(); zona.classList.remove("sobre"); enviar(ev.dataTransfer.files); });
  return el("div", {}, input, zona);
};
