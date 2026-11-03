/* Páginas: Cadastro (eventos, itens, medidores, chamados, energia, anexos) e Catálogo de preços. */
"use strict";

App.paginas.cadastro = async function (raiz, params) {
  let id = params[0] === "novo" ? "novo" : params[0] ? +params[0] : null;
  let aba = params[1] || "dados";
  const ro = !App.meta.editavel;   // precisa existir antes do formulário de "Novo evento"
  if (!App.catalogo) App.catalogo = await App.api("/api/catalogo");

  const busca = el("input", { type: "search", placeholder: "Buscar evento…" });
  const lista = el("div", { class: "lista-eventos" });
  const editor = el("div");
  raiz.append(
    el("div", { class: "pagina-cabecalho" },
      el("div", {}, el("h2", {}, "Cadastro"), el("p", {}, "Inclua eventos e lance itens, medidores, chamados e planilhas")),
      el("div", { class: "acoes" },
        ...App.importacao.botoesRelatorio(),
        App.btnEditor("Anexar relatório de evento", () => App.modal(el("div", {}, el("h3", {}, "Anexar relatório de evento"),
          App.zonaAnexoAutomatico(() => App.rotear()))), "btn btn--sec"),
        App.btnEditor("+ Novo evento", () => (location.hash = "#/cadastro/novo")))),
    el("div", { class: "cadastro" },
      el("aside", { class: "cartao" }, el("div", { class: "busca", style: { marginBottom: "10px" } }, busca), lista),
      editor));

  const desenharLista = () => {
    const q = App.norm(busca.value);
    App.limpar(lista);
    App.eventos.filter((e) => !q || App.norm(`${e.nome} ${App.fmt.data(e.data)} ${e.genero}`).includes(q)).forEach((e) => {
      lista.append(el("div", {
        class: "item" + (e.id === id ? " sel" : ""), onclick: () => (location.hash = `#/cadastro/${e.id}/${aba}`),
      }, el("span", { class: "ponto", style: { background: App.corCategoria(e.categoria) } }),
        el("div", {}, el("b", {}, e.nome), el("small", {}, `${App.fmt.data(e.data)} · ${e.genero || e.categoria || "—"}`)),
        el("span", { class: "valor" }, App.fmt.brlCurto(e.total))));
    });
  };
  busca.oninput = desenharLista;
  desenharLista();
  lista.querySelector(".sel")?.scrollIntoView({ block: "center" });

  if (id === "novo") return formEvento(editor, null);
  if (!id) { editor.append(el("div", { class: "cartao vazio" }, "Escolha um evento na lista ou crie um novo.")); return; }

  const e = await App.api(`/api/eventos/${id}`);
  const recarregar = async () => { await App.carregarEventos(); App.chamados = null; App.rotear(); };
  const abas = [["dados", "Dados do evento"], ["itens", `Itens (${e.itens.length})`], ["relogios", `Medidores (${e.relogios_lista.length})`],
    ["chamados", `Chamados (${e.chamados.length})`], ["energia", `Energia por hora (${e.energia.length})`], ["anexos", `Planilhas (${e.anexos.length})`]];
  const corpo = el("div");
  editor.append(el("div", { class: "cartao" },
    el("div", { class: "cartao__titulo" }, el("h3", {}, `${e.nome} · ${App.fmt.data(e.data)}`, App.botaoAjuda("Dados cadastrais do evento e os itens de custo lançados. O que você muda aqui altera os totais do evento em todas as telas.", "Evento")),
      el("span", { class: "sub" }, `Total ${App.fmt.brl(e.total)}`),
      el("div", { class: "dir" }, el("a", { class: "btn btn--sec btn--mini", href: `#/evento/${e.id}` }, "Ver dashboard"))),
    el("div", { class: "subabas" }, abas.map(([k, r]) => el("button", {
      class: k === aba ? "ativa" : "", onclick: () => (location.hash = `#/cadastro/${e.id}/${k}`),
    }, r))),
    corpo));

  if (ro) corpo.append(el("p", { class: "ajuda", style: { marginTop: 0 } }, "Modo somente leitura: entre com a senha de edição para alterar."));

  /* ------------------------------------------------ DADOS */
  if (aba === "dados") formEvento(corpo, e, recarregar);

  /* ------------------------------------------------ ITENS */
  if (aba === "itens") {
    const tipo = el("select", {}, App.meta.tipos_item.map((t) => el("option", { value: t }, t)));
    const dl = el("datalist", { id: "dl-catalogo" });
    const item = el("input", { type: "text", list: "dl-catalogo", placeholder: "Comece a digitar o item…", style: { width: "100%" } });
    const valor = el("input", { type: "number", step: "0.01", placeholder: "0,00" });
    const qtd = el("input", { type: "number", step: "0.01", value: "1" });
    const preencherDL = () => {
      App.limpar(dl);
      App.catalogo.filter((c) => c.tipo === tipo.value).forEach((c) => dl.append(el("option", { value: c.item }, App.fmt.brl(c.valor_unit))));
    };
    tipo.onchange = preencherDL;
    preencherDL();
    item.oninput = () => {
      const c = App.catalogo.find((x) => x.item === item.value.toUpperCase().trim() && x.tipo === tipo.value)
        || App.catalogo.find((x) => x.item === item.value.toUpperCase().trim());
      if (c) { valor.value = c.valor_unit; if (c.tipo !== tipo.value) { tipo.value = c.tipo; preencherDL(); } }
    };
    const add = el("button", { class: "btn" }, "Adicionar item");
    add.onclick = async () => {
      if (!item.value.trim()) return App.toast("Informe o item.", true);
      await salvarItens([{ tipo: tipo.value, item: item.value, valor_unit: valor.value, qtd: qtd.value }]);
    };
    const colar = el("textarea", { rows: 5, placeholder: "Cole linhas do Excel: ITEM | QTD (opcional: | VALOR UNIT. | TIPO)\nASSENTO SANITÁRIO SIMPLES\t3\nTÉCNICO ELEVADOR\t1", style: { width: "100%" } });
    const addColar = el("button", { class: "btn btn--sec" }, "Lançar itens colados");
    addColar.onclick = async () => {
      const linhas = colar.value.split(/\r?\n/).map((l) => l.split(/\t|;/).map((x) => x.trim())).filter((l) => l[0]);
      const naoAchou = [];
      const itens = linhas.map(([nome, q, v, t]) => {
        const c = App.catalogo.find((x) => x.item === nome.toUpperCase());
        if (!c && !v) naoAchou.push(nome);
        return { item: nome, qtd: q || 1, valor_unit: v ? v.replace(/\./g, "").replace(",", ".") : (c ? c.valor_unit : 0), tipo: t || (c ? c.tipo : tipo.value) };
      });
      if (naoAchou.length && !(await App.confirmar("Itens fora do catálogo", `Sem preço no catálogo: ${naoAchou.join(", ")}. Lançar com valor 0?`, "Lançar assim mesmo"))) return;
      await salvarItens(itens);
    };
    async function salvarItens(itens) {
      try {
        const r = await App.api(`/api/eventos/${e.id}/itens`, { method: "POST", json: { itens } });
        App.toast(`${r.inseridos} item(ns) lançado(s).`);
        recarregar();
      } catch (err) { App.toast(err.message, true); }
    }
    corpo.append(
      App.tabela([
        { rotulo: "Tipo", valor: (i) => i.tipo },
        { rotulo: "Item", valor: (i) => i.item },
        { rotulo: "Valor unit.", num: true, valor: (i) => i.valor_unit, render: (i) => App.fmt.brl(i.valor_unit) },
        { rotulo: "Qtd.", num: true, valor: (i) => i.qtd, render: (i) => App.fmt.num(i.qtd) },
        { rotulo: "Total", num: true, valor: (i) => i.total, render: (i) => App.fmt.brl(i.total), total: (l) => App.fmt.brl(App.soma(l, (i) => i.total)) },
        { rotulo: "", render: (i) => ro ? "" : el("span", { style: { whiteSpace: "nowrap" } },
          el("button", { class: "btn btn--mini btn--linha", title: "Editar", onclick: () => editarItem(i) }, "Editar"),
          el("button", { class: "btn btn--mini btn--linha", title: "Excluir", onclick: async () => { await App.api(`/api/itens/${i.id}`, { method: "DELETE" }); recarregar(); } }, "Excluir")) },
      ], e.itens, { rodape: true, vazio: "Nenhum item lançado." }),
      ro ? null : el("div", { class: "grade g-2", style: { marginTop: "16px" } },
        el("div", {}, el("h4", { style: { marginBottom: "10px" } }, "Adicionar um item"),
          el("div", { class: "form-grade" },
            el("label", { class: "campo" }, el("span", {}, "Tipo"), tipo),
            el("label", { class: "campo largo" }, el("span", {}, "Item (do catálogo ou novo)"), item, dl),
            el("label", { class: "campo" }, el("span", {}, "Valor unitário (R$)"), valor),
            el("label", { class: "campo" }, el("span", {}, "Quantidade"), qtd)),
          el("div", { class: "linha-acoes" }, add)),
        el("div", {}, el("h4", { style: { marginBottom: "10px" } }, "Colar vários de uma vez"), colar,
          el("p", { class: "ajuda" }, "O valor e o tipo vêm do catálogo quando o item já existe."),
          el("div", { class: "linha-acoes" }, addColar))));

    function editarItem(i) {
      const t = el("select", {}, App.meta.tipos_item.map((x) => el("option", { value: x, selected: x === i.tipo }, x)));
      const n = el("input", { type: "text", value: i.item });
      const v = el("input", { type: "number", step: "0.01", value: i.valor_unit });
      const q = el("input", { type: "number", step: "0.01", value: i.qtd });
      App.modal(el("div", {}, el("h3", {}, "Editar item"),
        el("div", { class: "form-grade" }, el("label", { class: "campo" }, el("span", {}, "Tipo"), t),
          el("label", { class: "campo largo" }, el("span", {}, "Item"), n),
          el("label", { class: "campo" }, el("span", {}, "Valor unit."), v), el("label", { class: "campo" }, el("span", {}, "Qtd."), q)),
        el("div", { class: "linha-acoes" }, el("button", {
          class: "btn", onclick: async () => {
            await App.api(`/api/itens/${i.id}`, { method: "PUT", json: { tipo: t.value, item: n.value, valor_unit: v.value, qtd: q.value } });
            App.fecharModal(); recarregar();
          },
        }, "Salvar"), el("button", { class: "btn btn--linha", "data-fechar": "" }, "Cancelar"))));
    }
  }

  /* ------------------------------------------------ MEDIDORES */
  if (aba === "relogios") {
    const un = { "ÁGUA": "m³", "GÁS": "m³", "ELÉTRICA": "kWh", "POÇO": "m³", "IRRIGAÇÃO": "m³" };
    const campos = App.meta.tipos_relogio.map((t) => {
      const r = e.relogios_lista.find((x) => x.tipo === t) || {};
      return { t, c: el("input", { type: "number", step: "0.001", value: r.consumo ?? "", disabled: ro }), v: el("input", { type: "number", step: "0.01", value: r.valor ?? "", disabled: ro }) };
    });
    const salvar = el("button", { class: "btn" }, "Salvar medidores");
    salvar.onclick = async () => {
      await App.api(`/api/eventos/${e.id}/relogios`, { method: "PUT", json: { relogios: campos.map((x) => ({ tipo: x.t, consumo: x.c.value, valor: x.v.value })) } });
      App.toast("Medidores salvos."); recarregar();
    };
    corpo.append(
      el("div", { class: "tabela-wrap" }, el("table", { class: "tabela" },
        el("thead", {}, el("tr", {}, el("th", {}, "Medidor"), el("th", {}, "Consumo"), el("th", {}, "Valor (R$)"))),
        el("tbody", {}, campos.map((x) => el("tr", {},
          el("td", {}, el("span", { class: "etiqueta" }, el("i", { style: { background: App.cores.relogio[x.t] } }), x.t)),
          el("td", {}, el("div", { style: { display: "flex", gap: "6px", alignItems: "center" } }, x.c, el("small", {}, un[x.t]))),
          el("td", {}, x.v)))))),
      el("p", { class: "ajuda" }, "Dica: anexe a planilha de custos do evento e use “Puxar medidores e chamados” para preencher automaticamente. "
        + "Irrigação do gramado (jogos): sem valor, o site calcula m³ × custo do m³ da água do evento."),
      ro ? null : el("div", { class: "linha-acoes" }, salvar));
  }

  /* ------------------------------------------------ CHAMADOS */
  if (aba === "chamados") {
    const desc = el("input", { type: "text", placeholder: "Descrição do chamado", style: { width: "100%" } });
    const dlT = el("datalist", { id: "dl-tipos" }, App.meta.tipos_chamado.map((t) => el("option", { value: t })));
    const tipo = el("input", { type: "text", list: "dl-tipos", placeholder: "HIDRÁULICA, ELÉTRICA…" });
    const ini = el("input", { type: "time" });
    const fim = el("input", { type: "time" });
    const add = el("button", { class: "btn" }, "Adicionar chamado");
    add.onclick = () => salvarCh([{ descricao: desc.value, tipo: tipo.value, hora_inicio: ini.value, hora_final: fim.value }]);
    const colar = el("textarea", { rows: 5, style: { width: "100%" }, placeholder: "Cole do Excel: DESCRIÇÃO | TIPO | INÍCIO | FIM\nBANHEIRO 108 SEM ÁGUA\tHIDRÁULICA\t18:03\t18:23" });
    const addColar = el("button", { class: "btn btn--sec" }, "Lançar chamados colados");
    addColar.onclick = () => salvarCh(colar.value.split(/\r?\n/).map((l) => l.split(/\t|;/).map((x) => x.trim())).filter((l) => l[0])
      .map(([d, t, i, f]) => ({ descricao: d, tipo: t, hora_inicio: i, hora_final: f })));
    async function salvarCh(chs) {
      try {
        const r = await App.api(`/api/eventos/${e.id}/chamados`, { method: "POST", json: { chamados: chs } });
        App.toast(`${r.inseridos} chamado(s) lançado(s).`); recarregar();
      } catch (err) { App.toast(err.message, true); }
    }
    corpo.append(
      App.tabela([
        { rotulo: "Descrição", valor: (c) => c.descricao },
        { rotulo: "Tipo", valor: (c) => c.tipo },
        { rotulo: "Início", valor: (c) => c.hora_inicio },
        { rotulo: "Fim", valor: (c) => c.hora_final },
        { rotulo: "Tempo", num: true, valor: (c) => c.tempo, render: (c) => App.fmt.min(c.tempo) },
        { rotulo: "", render: (c) => ro ? "" : el("button", { class: "btn btn--mini btn--linha", title: "Excluir", onclick: async () => { await App.api(`/api/chamados/${c.id}`, { method: "DELETE" }); recarregar(); } }, "Excluir") },
      ], e.chamados, { vazio: "Nenhum chamado." }),
      ro ? null : el("div", { class: "grade g-2", style: { marginTop: "16px" } },
        el("div", {}, el("h4", { style: { marginBottom: "10px" } }, "Adicionar um chamado"),
          el("div", { class: "form-grade" }, el("label", { class: "campo largo" }, el("span", {}, "Descrição"), desc),
            el("label", { class: "campo" }, el("span", {}, "Tipo"), tipo, dlT),
            el("label", { class: "campo" }, el("span", {}, "Início"), ini), el("label", { class: "campo" }, el("span", {}, "Fim"), fim)),
          el("div", { class: "linha-acoes" }, add)),
        el("div", {}, el("h4", { style: { marginBottom: "10px" } }, "Colar vários de uma vez"), colar, el("div", { class: "linha-acoes" }, addColar))));
  }

  /* ------------------------------------------------ ENERGIA */
  if (aba === "energia") {
    const txt = el("textarea", { rows: 14, style: { width: "100%" }, disabled: ro },
      e.energia.map((h) => `${h.hora}\t${String(h.consumo).replace(".", ",")}`).join("\n"));
    const salvar = el("button", { class: "btn" }, "Salvar curva");
    salvar.onclick = async () => {
      const linhas = txt.value.split(/\r?\n/).map((l) => l.split(/\t|;/).map((x) => x.trim())).filter((l) => l[0])
        .map(([h, c]) => ({ hora: h, consumo: (c || "0").replace(/\./g, "").replace(",", ".") }));
      await App.api(`/api/eventos/${e.id}/energia`, { method: "PUT", json: { linhas } });
      App.toast("Curva de energia salva."); recarregar();
    };
    corpo.append(el("p", { class: "ajuda", style: { marginTop: 0 } }, "Uma linha por hora: HORA | CONSUMO (kWh). Pode colar direto do Excel."), txt,
      ro ? null : el("div", { class: "linha-acoes" }, salvar));
  }

  /* ------------------------------------------------ ANEXOS */
  if (aba === "anexos") corpo.append(App.blocoAnexos(e, recarregar));

  /* ------------------------------------------------ formulário do evento */
  function formEvento(alvo, ev, aoSalvar) {
    const v = ev || { nome: "", data: "", categoria: "", genero: "", horario: "", publico: "", cliente: "", observacoes: "" };
    const dlC = el("datalist", { id: "dl-cat" }, ["SHOW", "JOGO", "PROJETO ESPECIAL", ...App.meta.categorias].filter((x, i, a) => a.indexOf(x) === i).map((c) => el("option", { value: c })));
    const dlG = el("datalist", { id: "dl-gen" }, App.meta.generos.map((g) => el("option", { value: g })));
    const dlN = el("datalist", { id: "dl-nomes" }, [...new Set(App.eventos.map((x) => x.nome))].map((n) => el("option", { value: n })));
    const f = {
      nome: el("input", { type: "text", value: v.nome, list: "dl-nomes", required: true }),
      data: el("input", { type: "date", value: v.data, required: true }),
      categoria: el("input", { type: "text", value: v.categoria, list: "dl-cat" }),
      genero: el("input", { type: "text", value: v.genero, list: "dl-gen" }),
      horario: el("input", { type: "time", value: v.horario || "" }),
      publico: el("input", { type: "number", value: v.publico ?? "" }),
      cliente: el("input", { type: "text", value: v.cliente || "" }),
      observacoes: el("textarea", { rows: 3 }, v.observacoes || ""),
    };
    // ao digitar um nome que já existe, sugere categoria e gênero
    f.nome.addEventListener("change", () => {
      const ant = App.eventos.find((x) => x.nome === f.nome.value.toUpperCase().trim());
      if (ant && !f.categoria.value) { f.categoria.value = ant.categoria; f.genero.value = ant.genero; }
    });
    if (ro) Object.values(f).forEach((x) => (x.disabled = true));
    const salvar = el("button", { class: "btn" }, ev ? "Salvar alterações" : "Criar evento");
    salvar.onclick = async () => {
      const dados = Object.fromEntries(Object.entries(f).map(([k, x]) => [k, x.value]));
      try {
        if (ev) {
          await App.api(`/api/eventos/${ev.id}`, { method: "PUT", json: dados });
          App.toast("Evento salvo."); aoSalvar();
        } else {
          const r = await App.api("/api/eventos", { method: "POST", json: dados });
          await App.carregarEventos(); App.meta = await App.api("/api/meta");
          location.hash = `#/cadastro/${r.id}/itens`;
        }
      } catch (err) { App.toast(err.message, true); }
    };
    const extras = ev && !ro ? [
      el("button", {
        class: "btn btn--sec", onclick: async () => {
          const d = await App.perguntar("Duplicar para outro dia", "Data do novo dia do evento", "date");
          if (!d) return;
          try {
            const r = await App.api(`/api/eventos/${ev.id}/duplicar`, { method: "POST", json: { data: d, copiar_mdo: true } });
            await App.carregarEventos(); App.toast("Novo dia criado (com os itens de MDO copiados).");
            location.hash = `#/cadastro/${r.id}/dados`;
          } catch (err) { App.toast(err.message, true); }
        },
      }, "Duplicar para outro dia"),
      el("button", {
        class: "btn btn--perigo", style: { marginLeft: "auto" }, onclick: async () => {
          if (!(await App.confirmar("Excluir evento", `Excluir ${ev.nome} (${App.fmt.data(ev.data)}) com todos os itens, medidores, chamados e anexos?`, "Excluir"))) return;
          await App.api(`/api/eventos/${ev.id}`, { method: "DELETE" });
          await App.carregarEventos(); location.hash = "#/cadastro";
        },
      }, "Excluir evento")] : [];
    alvo.append(el(ev ? "div" : "section", { class: ev ? "" : "cartao" },
      ev ? null : el("div", { class: "cartao__titulo" }, el("h3", {}, "Novo evento", App.botaoAjuda("Cadastro manual de um evento (nome, data, categoria, gênero). Depois de criado, anexe o relatório de custos para preencher itens, medidores e chamados.", "Novo evento"))),
      el("div", { class: "form-grade" },
        el("label", { class: "campo largo" }, el("span", {}, "Nome do evento *"), f.nome, dlN),
        el("label", { class: "campo" }, el("span", {}, "Data *"), f.data),
        el("label", { class: "campo" }, el("span", {}, "Horário"), f.horario),
        el("label", { class: "campo" }, el("span", {}, "Categoria"), f.categoria, dlC),
        el("label", { class: "campo" }, el("span", {}, "Gênero"), f.genero, dlG),
        el("label", { class: "campo" }, el("span", {}, "Público"), f.publico),
        el("label", { class: "campo" }, el("span", {}, "Cliente"), f.cliente),
        el("label", { class: "campo largo" }, el("span", {}, "Observações"), f.observacoes)),
      el("p", { class: "ajuda" }, "Eventos com mais de um dia (ex.: FESTIVAL DEMO) são cadastrados um registro por dia, com o mesmo nome. Assim dá para comparar os dias."),
      ro ? null : el("div", { class: "linha-acoes" }, salvar, ...extras)));
  }
};

/* ====================================================================== CATÁLOGO */
App.paginas.catalogo = async function (raiz) {
  App.catalogo = await App.api("/api/catalogo");
  const ro = !App.meta.editavel;
  const busca = el("input", { type: "search", placeholder: "Buscar item…" });
  const filtroTipo = el("select", {}, el("option", { value: "" }, "Todos os tipos"), App.meta.tipos_item.map((t) => el("option", { value: t }, t)));
  const caixa = el("div");
  const novo = App.btnEditor("+ Novo item", () => editar({}));
  raiz.append(
    el("div", { class: "pagina-cabecalho" },
      el("div", {}, el("h2", {}, "Catálogo de preços"), el("p", {}, "Valores unitários de avarias, MDO e insumos usados no lançamento dos itens")),
      el("div", { class: "acoes" }, ...App.importacao.botoesRelatorio(async () => { App.catalogo = null; App.rotear(); }), novo)),
    App.barraPadrao({ campos: [App.campo("Tipo", filtroTipo)], busca,
      limpar: () => { filtroTipo.value = ""; busca.value = ""; desenhar(); } }),
    caixa);
  const desenhar = () => {
    const q = App.norm(busca.value);
    const ls = App.catalogo.filter((c) => (!filtroTipo.value || c.tipo === filtroTipo.value) && (!q || App.norm(c.item).includes(q)));
    App.limpar(caixa).append(App.cartao("Itens", `${ls.length} itens`, App.tabela([
      { rotulo: "Tipo", valor: (c) => c.tipo, render: (c) => el("span", { class: "etiqueta" }, el("i", { style: { background: App.cores.componente[c.tipo] } }), c.tipo) },
      { rotulo: "Item", valor: (c) => c.item },
      { rotulo: "Valor unit.", num: true, valor: (c) => c.valor_unit, render: (c) => App.fmt.brl(c.valor_unit) },
      { rotulo: "", render: (c) => ro ? "" : el("span", { style: { whiteSpace: "nowrap" } },
        el("button", { class: "btn btn--mini btn--linha", title: "Editar", onclick: () => editar(c) }, "Editar"),
        el("button", {
          class: "btn btn--mini btn--linha", title: "Excluir", onclick: async () => {
            if (!(await App.confirmar("Excluir item do catálogo", c.item, "Excluir"))) return;
            await App.api(`/api/catalogo/${c.id}`, { method: "DELETE" }); App.paginas.catalogo(App.limpar(raiz));
          },
        }, "Excluir")) },
    ], ls, { ordem: { i: 1, dir: 1 } })));
  };
  busca.oninput = desenhar; filtroTipo.onchange = desenhar;
  desenhar();

  /* ---- siglas de área dos chamados */
  const siglas = await App.api("/api/siglas");
  const boxSiglas = el("div");
  raiz.append(el("div", { style: { height: "16px" } }), App.cartao("Siglas de área (CHAMADOS CCO)",
    "como cada sigla da coluna ÁREA vira o tipo do chamado · ao salvar, chamados com a sigla antiga são corrigidos", boxSiglas));
  const desenharSiglas = () => {
    App.limpar(boxSiglas).append(App.tabela([
      { rotulo: "Sigla", valor: (s) => s.sigla, render: (s) => el("b", {}, s.sigla) },
      { rotulo: "Área / tipo do chamado", valor: (s) => s.tipo },
      { rotulo: "", render: (s) => ro ? "" : el("span", { style: { whiteSpace: "nowrap" } },
        el("button", { class: "btn btn--mini btn--linha", title: "Editar", onclick: () => editarSigla(s) }, "Editar"),
        el("button", {
          class: "btn btn--mini btn--linha", title: "Excluir", onclick: async () => {
            await App.api(`/api/siglas/${encodeURIComponent(s.sigla)}`, { method: "DELETE" });
            siglas.splice(siglas.indexOf(s), 1); desenharSiglas();
          },
        }, "Excluir")) },
    ], siglas), ro ? null : el("div", { class: "linha-acoes" }, el("button", { class: "btn btn--sec", onclick: () => editarSigla({}) }, "+ Nova sigla")));
  };
  desenharSiglas();

  function editarSigla(s) {
    const sg = el("input", { type: "text", value: s.sigla || "", placeholder: "Ex.: HD" });
    const dlT = el("datalist", { id: "dl-tipos-sigla" }, [...new Set([...siglas.map((x) => x.tipo), ...App.meta.tipos_chamado])].map((t) => el("option", { value: t })));
    const tp = el("input", { type: "text", value: s.tipo || "", list: "dl-tipos-sigla", placeholder: "Ex.: HIDRÁULICA" });
    App.modal(el("div", {}, el("h3", {}, s.sigla ? "Editar sigla" : "Nova sigla"),
      el("div", { class: "form-grade" }, el("label", { class: "campo" }, el("span", {}, "Sigla"), sg),
        el("label", { class: "campo" }, el("span", {}, "Área / tipo"), tp, dlT)),
      el("p", { class: "ajuda" }, "Chamados que já entraram com essa sigla (por não estar cadastrada) passam a usar o nome da área."),
      el("div", { class: "linha-acoes" }, el("button", {
        class: "btn", onclick: async () => {
          try {
            const r = await App.api("/api/siglas", { method: "POST", json: { sigla: sg.value, tipo: tp.value, sigla_antiga: s.sigla } });
            App.fecharModal(); App.chamados = null;
            App.toast("Sigla salva" + (r.chamados_atualizados ? ` · ${r.chamados_atualizados} chamado(s) corrigido(s)` : "."));
            App.paginas.catalogo(App.limpar(raiz));
          } catch (err) { App.toast(err.message, true); }
        },
      }, "Salvar"), el("button", { class: "btn btn--linha", "data-fechar": "" }, "Cancelar"))));
  }

  function editar(c) {
    const t = el("select", {}, App.meta.tipos_item.map((x) => el("option", { value: x, selected: x === c.tipo }, x)));
    const n = el("input", { type: "text", value: c.item || "" });
    const v = el("input", { type: "number", step: "0.01", value: c.valor_unit ?? "" });
    App.modal(el("div", {}, el("h3", {}, c.id ? "Editar item" : "Novo item"),
      el("div", { class: "form-grade" }, el("label", { class: "campo" }, el("span", {}, "Tipo"), t),
        el("label", { class: "campo largo" }, el("span", {}, "Item"), n), el("label", { class: "campo" }, el("span", {}, "Valor unitário (R$)"), v)),
      el("div", { class: "linha-acoes" }, el("button", {
        class: "btn", onclick: async () => {
          try {
            await App.api("/api/catalogo", { method: "POST", json: { id: c.id, tipo: t.value, item: n.value, valor_unit: v.value } });
            App.fecharModal(); App.paginas.catalogo(App.limpar(raiz));
          } catch (err) { App.toast(err.message, true); }
        },
      }, "Salvar"), el("button", { class: "btn btn--linha", "data-fechar": "" }, "Cancelar"))));
  }
};
