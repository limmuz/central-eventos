/* Textos do botão "?" de cada cartão, indicador e coluna.
   Formato do texto: parágrafos separados por linha em branco; linhas começando com "- " viram lista; **x** = negrito.
   App.AJUDA: [título do cartão (início, sem diferença de acento/maiúscula) ou RegExp, texto]. Títulos mais longos são testados primeiro. */
"use strict";

const _pag = () => location.hash.replace(/^#\/?/, "").split("/")[0] || "visao";

/* ================================================================== SUPRIMENTOS (textos usados direto no pag_sup.js) */
const AJ = {
  kpiTotal: `**Soma de todas as notas (contas) de energia elétrica, água e gás lançadas em Contas do mês.**

É o valor que o Arena Demo pagou às concessionárias no mês, antes de qualquer divisão. O poço artesiano não entra aqui: ele tem o próprio quadro.

Por que importa: é o valor de partida do rateio. Tudo o que é cobrado das áreas + a Parte da Engenharia tem que dar este total.`,
  kpiConta: (u) => `**Valor da(s) nota(s) de ${u} do mês** (soma das contas desse tipo em Contas do mês; pode haver mais de uma, ex.: Enel + Esfera).

Embaixo: quanto dessa conta ficou com a Engenharia e o % da nota que isso representa.

Como chega nesse número: Parte da Engenharia = valor da nota − tudo o que foi cobrado das linhas do rateio (locatários, eventos e áreas), já com os descontos.`,
  kpiPoco: `**Valor total do poço artesiano no mês = valor da conta “Poço Artesiano” lançada em Contas do mês** (a NF do poço).

O poço é água tirada do próprio poço, separada da conta da Sabesp. Por isso a conta do poço não soma na conta de água.

- Eventos: o valor vem do Relatório de eventos (m³ do medidor × tarifa do relatório).
- Locatários e áreas: você digita na coluna Poço artesiano da tabela de rateio.
- Parte da Engenharia do poço = conta do poço − eventos − locatários.

Sem a conta do poço lançada, o quadro mostra só a soma das linhas e não dá para calcular a parte da Engenharia.

Se o poço for somado à água (botão “Colunas” da tabela de rateio, desmarcando Poço artesiano), este quadro some e o poço passa a fazer parte da conta de água.`,
  kpiEng: `**Quanto das contas do mês fica com a Engenharia (centro de custo e projeto definidos em Configurações).**

Conta: total das notas − tudo o que foi repassado (cobrado) dos locatários, eventos e áreas. Os descontos dados às linhas também ficam com a Engenharia.

Embaixo: o total repassado às áreas e o total de descontos. É este valor que vai para o budget, na classe que você escolher em “No budget”.`,
  colConta: `Tipo da conta: energia elétrica, água, gás ou poço artesiano.

O tipo decide em qual coluna do rateio a nota é dividida. Uma conta com fornecedor “Poço Artesiano” é a nota do poço: não soma na água da Sabesp.`,
  colValorNota: `**Valor cheio da nota / fatura**, como veio da concessionária (ou a NF do poço).

É o valor pago no mês, antes do rateio. A linha de total soma todas as notas do mês.`,
  colEngConta: `**Quanto desta nota fica com a Engenharia.** É o mesmo valor da linha “Parte da Engenharia” no rateio, na coluna desta conta.

- Energia, água e gás: valor da nota − o que foi cobrado das linhas do rateio. Com duas notas do mesmo tipo (ex.: Enel + Esfera), a parte da Engenharia é dividida pelo valor de cada nota.
- Poço artesiano: nota do poço − eventos − locatários.

Embaixo aparece o % da nota que ficou com a Engenharia. Para mudar este valor, ajuste as linhas do rateio.`,
  colBudget: `Em qual linha do budget (classe financeira + centro de custo + projeto) a **Parte da Engenharia** desta conta é lançada, e em que %.

O valor lançado aparece no Budget como incorrido do tipo “CONSUMO”, no mês da conta. Só a parte da Engenharia vai para o budget; o que foi cobrado das áreas não.

Linha marcada em vermelho = não está no budget do ano (o valor não é somado lá).`,
  colLinha: `Quem paga: locatário, evento, área do parque ou a própria Engenharia.

Embaixo: o centro de custo (CC) e o projeto que recebem o valor na planilha do Suprimentos. Linha sem código sai na planilha sem o CC / projeto: abra a linha e escolha.`,
  colRateioU: (u) => `**Quanto esta linha paga da conta de ${u} (R$), já com desconto.**

De onde vem o número:
- Linha medida (você digitou o consumo): consumo × tarifa do mês. A conta aparece embaixo (ex.: 1.200 kWh × R$ 0,85).
- Linha de evento: o valor do Relatório de eventos.
- Demais linhas: o valor em R$ que você digitou.

“% da conta” = esse valor ÷ valor da(s) nota(s) de ${u} do mês. Desconto aparece em vermelho e volta para a Engenharia.

Na linha **Parte da Engenharia**: nota − soma de todas as linhas.`,
  colRateioPoco: `**Quanto esta linha paga do poço artesiano (R$).**

- Eventos: vem do Relatório de eventos (marcado “do Relatório”).
- Locatários e áreas: você digita aqui.

“% do poço” = valor da linha ÷ conta do poço do mês. Na linha Parte da Engenharia: conta do poço − eventos − locatários. Na linha Total das contas: a conta do poço (R$ e m³).`,
  colDesconto: `Desconto em % que a linha recebe, e em quais contas ele vale (energia, água, gás).

O valor descontado não é cobrado da linha: ele volta para a Parte da Engenharia.`,
  colCobrado: `**Total que esta linha paga no mês:** energia + água + gás + poço, já com desconto.

O rodapé “Repassado às áreas” soma todas as linhas. Repassado + Parte da Engenharia = total das contas.`,
  colMes: `Mês da competência das contas. Clique na linha para abrir as linhas de rateio daquele mês, ou em “abrir o rateio” para ir à tela do mês.`,
  colMesMed: (u, n) => u === "poco"
    ? `**Valor total do poço artesiano no mês (R$)** = soma do que foi lançado para eventos, locatários e a Parte da Engenharia. Com a conta do poço lançada, é o valor da NF do poço.

Embaixo (m³): consumo somado só das linhas que têm medição (eventos do Relatório e linhas com m³). Não é o consumo total do poço.`
    : `**Valor total da(s) nota(s) de ${n.toLowerCase()} no mês (R$).** É a soma do que foi cobrado de todas as linhas + a Parte da Engenharia, que fecha com o valor das notas.

Embaixo (${u === "energia" ? "kWh" : "m³"}): consumo somado só das linhas que têm medição (eventos do Relatório e linhas com consumo digitado). Não é o consumo da conta inteira.

Com filtro de grupo, centro de custo ou linha, o valor é só do que está no filtro.`,
  colMesTotal: `Soma dos medidores escolhidos no filtro (energia + água + gás + poço) no mês. Sem filtro, é o total de todas as notas do mês, incluindo a conta do poço.`,
  colGrupo: `Grupo da linha: Engenharia, Locatários e áreas, Shows, Jogos ou Projetos especiais. O grupo sai do centro de custo (Configurações → Centro de custo dos eventos); o que não é evento nem Engenharia é Locatários e áreas.`,
  colLinhaMed: (u, n) => `**Quanto esta linha pagou de ${n.toLowerCase()} no mês (R$)**, já com desconto. Não é o valor da nota: é a parte dela que foi cobrada desta linha (ou, na linha Parte da Engenharia, o que sobrou para a Engenharia).

Embaixo:
- ${u === "energia" ? "kWh" : "m³"}: consumo medido da linha, quando existe.
- %: quanto esse valor representa ${u === "poco" ? "do poço do mês (conta do poço)" : "da nota do mês"}.${u === "poco" ? "\n\n“≈” = sem medição de poço, % aproximado igual ao % de água da linha." : ""}`,
  colLinhaTotal: `Soma do que a linha pagou no mês nos medidores escolhidos (energia + água + gás + poço). É o valor cobrado da linha, não o valor das notas.`,
  colPeriodoMed: (n) => `Quanto a linha pagou de ${n.toLowerCase()} somando todos os meses do período (R$, já com desconto). É a parte da nota cobrada da linha, não o valor da nota.`,
  kpiResTotal: `Soma de tudo o que foi cobrado das linhas no período, nos medidores e filtros escolhidos, incluindo a Parte da Engenharia.

Sem filtro de grupo / centro de custo / linha, é a soma de todas as notas do período (energia, água, gás e poço).`,
  kpiResMed: (n) => `Total de ${n} no período (R$), somando o que foi cobrado das linhas no filtro + a Parte da Engenharia. Sem filtros, é a soma das notas de ${n} dos meses escolhidos.

Embaixo: média por mês = total ÷ número de meses do período.`,
  kpiResEng: `Quanto ficou com a Engenharia no período, somando todos os meses: em cada mês, nota − o que foi cobrado das áreas (inclui os descontos). Embaixo: % que isso representa do total do filtro.`,
};

/* ================================================================== CARTÕES */
const _ajudaCartoes = [
  /* ---------- Suprimentos */
  ["Contas das concessionárias (notas do mês)", `**Lista das notas que chegaram no mês: energia elétrica (Enel, Esfera), água (Sabesp), gás (Comgás) e a NF do poço artesiano.**

É o ponto de partida do rateio: o valor de cada nota é dividido entre as linhas da tabela “Rateio do mês” e o que sobra é a Parte da Engenharia.

- Valor da nota: o valor cheio do documento.
- Parte da Engenharia: quanto da nota fica com a Engenharia (o mesmo número da linha Parte da Engenharia do rateio).
- No budget: em qual classe / centro de custo / projeto essa parte da Engenharia é lançada no Budget.

O poço artesiano é lançado aqui como uma conta com fornecedor “Poço Artesiano”: ela vira o total do poço do mês e não soma na água da Sabesp.`],
  ["Rateio do mês por centro de custo / projeto", `**Quanto cada locatário, evento e área paga de cada conta no mês, e quanto fica com a Engenharia.**

Como cada valor é formado:
- Linha com consumo digitado (kWh / m³): consumo × tarifa do mês.
- Evento: valores do Relatório de eventos (energia, água, gás e poço).
- Outras linhas: valor em R$ digitado.
- Desconto: a parte descontada não é cobrada e volta para a Engenharia.

No rodapé:
- Repassado às áreas: soma das linhas.
- Parte da Engenharia: nota − repassado (fica no centro de custo e projeto da Engenharia).
- Total das contas: valor das notas do mês.

Por que existe: é a base da planilha de importação do Suprimentos, que distribui cada conta entre os centros de custo.`],
  ["Divisão de cada conta entre os centros de custo", `**Uma barra por conta (energia, água, gás), dividida pela cor de cada centro de custo.**

Cada pedaço é a soma do que foi cobrado das linhas daquele centro de custo; o verde é a Parte da Engenharia. A barra inteira é o valor da nota.

Serve para ver de relance quem pesa mais em cada conta.`],
  ["Tarifa do mês (R$ por kWh / m³)", `**Preço de cada unidade consumida: valor da conta ÷ consumo da conta.**

Exemplo: conta de energia de R$ 85.000 com 100.000 kWh → R$ 0,85 por kWh.

É usada nas linhas em que você digita o consumo (kWh ou m³) em vez do valor: o valor da linha = consumo × tarifa. Por padrão a medição de um mês usa a conta do mês anterior (Configurações → Como calcular a tarifa). Você pode digitar a tarifa direto em “Editar”.`],
  ["Valor de cada mês, por grupo", `**Uma barra por mês; cada cor é um grupo (Engenharia, Locatários e áreas, Shows, Jogos, Projetos especiais).**

Altura de cada pedaço = soma do que foi cobrado das linhas daquele grupo no mês, nos medidores escolhidos. Sem filtro, a barra inteira = total das notas do mês.

Serve para ver como a divisão entre os grupos muda mês a mês.`],
  ["Total do período por grupo", `Soma, em todos os meses do filtro, do que cada grupo pagou (R$, nos medidores escolhidos). Passe o mouse para ver o % de cada grupo no total.`],
  ["Valor de cada mês, por medidor", `**Uma barra por mês; cada cor é um medidor (energia, água, gás, poço).**

Sem filtro de grupo / linha, a barra é o total das notas do mês. Com filtro, é só o que foi cobrado das linhas filtradas. Serve para ver qual conta cresce ou cai ao longo do ano.`],
  ["As 15 linhas que mais pagam", `As 15 linhas (locatários, eventos, áreas, Engenharia) com o maior valor somado no período, nos medidores escolhidos. A cor é o grupo da linha. Passe o mouse para ver em quantos meses a linha aparece.`],
  ["Mês a mês: valor de cada medidor", `**Um mês por linha. Clique no mês para abrir todas as linhas de rateio dele.**

Na linha do mês:
- Energia / Água / Gás / Poço (R$): valor total do mês no medidor. Sem filtros, é o valor das notas (cobrado das linhas + Parte da Engenharia).
- Consumo embaixo (kWh / m³): só das linhas com medição, não o consumo da conta inteira.

Ao abrir o mês, cada linha mostra:
- R$: quanto aquela linha pagou daquela conta (não o valor da nota).
- kWh / m³: consumo medido da linha.
- %: quanto esse valor representa da nota do mês (no poço, da conta do poço).

Use o ? de cada coluna para ver o que o número representa.`],
  ["Total de cada linha no período", `Soma de todos os meses do período para cada linha, por medidor (R$ cobrado da linha, já com desconto). Clique no título de uma coluna para ordenar.`],
  ["Centro de custo e projeto da Engenharia", `Centro de custo e projeto que recebem a **Parte da Engenharia** (o que sobra de cada conta depois de cobrar as áreas). São usados na linha Parte da Engenharia do rateio, na planilha do Suprimentos e para identificar as linhas da Engenharia no budget.`],
  ["Centro de custo dos eventos", `Centro de custo de cada tipo de evento (shows, jogos, projetos especiais). É usado nas linhas trazidas do Relatório de eventos e para separar os grupos no Resumo por mês. O que não for evento nem Engenharia vira “Locatários e áreas”.`],
  ["Poço artesiano nos meses novos", `Define como o poço artesiano aparece nos meses criados daqui em diante:
- Coluna própria: a conta “Poço Artesiano” é o total do poço, separado da Sabesp; cada linha tem o seu valor de poço.
- Somado à água: a conta do poço soma na conta de água (como Enel + Esfera na energia) e o poço de cada linha entra no valor de água dela.

Em qualquer mês dá para mudar no botão “Colunas” da tabela de rateio. Nada é apagado ao trocar.`],
  ["Planilha de importação do Suprimentos", `Códigos fixos que vão no cabeçalho da planilha de importação do Suprimentos (agente de cada concessionária, organização, filial e ação). Mude só se o Suprimentos trocar os códigos.`],
  ["Como calcular a tarifa", `Escolhe de qual mês sai a tarifa usada nas linhas com consumo: a conta do mês anterior (padrão, igual à planilha de consumos) ou a conta do mesmo mês. Tarifa = valor da fatura ÷ consumo da fatura.`],
  ["GateX (medição de energia)", `Link do GateX de onde o botão “Puxar consumo do GateX” lê o consumo de energia (kWh) de cada locatário e evento. O valor em R$ é kWh × tarifa de energia do mês. Quando a sessão do GateX expirar, cole o link novo.`],

  /* ---------- Visão geral */
  ["Custo por evento", `**Custo de cada evento, dividido por componente (cores).**

Componentes:
- Medidores de consumo: água, energia, gás e poço lidos no evento (nos jogos, a irrigação do gramado já está dentro da água).
- Mão de obra (MDO): técnicos e equipes (quantidade × valor unitário).
- Avarias: itens danificados (quantidade × valor).
- Insumos: materiais usados.

Tamanho da barra = soma dos componentes escolhidos no filtro. Clique numa barra para abrir o evento. Use “Top” e “Ordem” para mudar quantos e em que ordem aparecem.`],
  ["Média por gênero", `**Custo médio por evento de cada gênero** (soma do custo dos eventos do gênero ÷ número de eventos do gênero), nos componentes escolhidos. A cor é a categoria mais comum naquele gênero. Serve para estimar o custo de um evento novo do mesmo tipo.`],
  ["Média por categoria", `**Custo médio por evento de cada categoria (Show, Jogo, etc.), separado por componente.** Cada barra = soma do componente nos eventos da categoria ÷ número de eventos da categoria. Os quadros embaixo mostram a média total de cada categoria.`],
  ["Custo por mês", `**Soma do custo de todos os eventos de cada mês**, por componente. Mostra em que meses o parque gastou mais com eventos. O número em cima da barra é o total do mês.`],
  ["Medidores de consumo", `**Valor médio de cada medidor (R$) por evento, separado por categoria.** Só entram os eventos que têm leitura de medidor. Nos jogos, a irrigação do gramado já está dentro da água (não soma à parte; jogos a partir de out/2026).`],
  ["Eventos", () => _pag() === "sup" ? "" : `Lista dos eventos do filtro com o custo de cada componente e o total (soma dos componentes escolhidos). Clique no título da coluna para ordenar e na linha para abrir o evento.`],

  /* ---------- Evento */
  ["Composição do custo", `**Como o custo total do evento se divide entre os componentes** (medidores de consumo, mão de obra, avarias e insumos). Custo total = soma de todos os componentes.`],
  ["Energia por hora", `**Consumo de energia elétrica (kWh) em cada hora do evento**, lido do medidor. Mostra o horário de pico, útil para planejar equipes e montagem.`],
  ["Chamados de manutenção", `**Chamados abertos durante o evento.** Tempo = da abertura até a execução. SLA = chamado resolvido em até 60 minutos. Os quadros mostram o tempo médio, o % dentro do SLA e o maior tempo.`],
  ["Comparado à média de", `**Este evento contra a média dos outros eventos da mesma categoria.** Diferença = (custo do evento − média da categoria) ÷ média da categoria. Positivo = mais caro que o normal.`],
  ["Itens de custo", `Todos os itens lançados no evento (MDO, avarias, insumos) com quantidade, valor unitário e total (quantidade × valor unitário).`],
  ["Planilhas anexadas", `Arquivos Excel anexados ao evento (relatório de custos, custos operacionais). Clique para baixar. É daqui que saem os valores do evento.`],

  /* ---------- Avarias */
  [/^top \d+ itens por valor/, `Os itens com maior valor de avarias somado no filtro (quantidade × valor unitário, somando todos os eventos).`],
  [/^top \d+ eventos por valor de avarias/, `Os eventos com maior valor de avarias somado. Clique para abrir o evento.`],
  ["Avarias por mês", `Soma do valor de avarias (quantidade × valor unitário) dos eventos de cada mês.`],
  ["Avarias por categoria", `Valor total de avarias por categoria de evento. No detalhe (passe o mouse): média por evento da categoria.`],
  ["Por item avariado", `Cada item danificado com quantidade total, valor total e em quantos eventos aconteceu. Clique para ver os eventos.`],
  ["Por evento", `Cada evento com avaria, com quantidade de itens e valor total. Clique para ver as avarias do evento.`],
  ["Avarias por item", `Valor total de cada item avariado neste evento (quantidade × valor unitário).`],
  ["Lista de avarias", `Cada avaria lançada: item, quantidade, valor unitário e total.`],

  /* ---------- Manutenção */
  ["Média de tempo por tipo de chamado", `**Tempo médio de atendimento de cada tipo de chamado (hh:mm)** = soma dos tempos ÷ número de chamados do tipo. Tempo = abertura até a execução. Mostra quais tipos demoram mais.`],
  ["Quantidade de chamados por tipo", `Número de chamados de cada tipo no filtro. Mostra o que mais quebra ou é mais pedido.`],
  ["Volume de chamados por horário", `**Quantos chamados foram abertos em cada hora do dia**, somando os eventos do filtro. Mostra o horário de pico de demanda da equipe.`],
  ["Eventos com mais chamados", `Os 25 eventos com mais chamados. Clique para ver só os chamados daquele evento.`],
  ["Chamados", () => _pag() === "comparar" ? `Lista dos chamados do lado A ou B, com tipo, horário e tempo de atendimento.` : `Lista de todos os chamados do filtro: tipo, área, horário de abertura e execução, tempo e se ficou dentro do SLA (até 60 min).`],

  /* ---------- Comparar */
  ["Custo por componente", `**Lado a lado, o custo de A e de B em cada componente** (medidores, MDO, avarias, insumos). Comparando períodos, os valores são médias por evento.`],
  ["Diferenças por componente", `Média por evento de B − média por evento de A, por componente. Positivo = B gastou mais.`],
  ["Diferenças", `Tabela da diferença B − A por componente, em R$ e em %. Positivo = B mais caro.`],
  ["Consumo dos medidores", `Leituras físicas (kWh e m³) de cada medidor em A e B. Compara consumo, não valor: serve para ver se a diferença de custo vem de consumo ou de tarifa.`],
  ["Itens lado a lado", `Cada item de custo com quantidade e valor em A e em B, e a diferença.`],
  ["Custos operacionais (planilhas anexadas)", `Compara as planilhas de custos operacionais anexadas aos dois eventos, linha a linha.`],
  [/^itens avariados · top/, `Os itens com mais avarias, com o valor em A e em B.`],
  ["Avarias lado a lado", `Cada item avariado com valor em A e B e a diferença (positivo = B maior).`],
  ["Chamados por tipo", `Quantidade de chamados de cada tipo em A e B (comparando períodos: média por evento ou total).`],
  ["Tempo médio por tipo", `Tempo médio de atendimento (hh:mm) de cada tipo de chamado em A e B.`],
  ["Indicadores de manutenção", `Resumo da manutenção em A e B: número de chamados, tempo médio, tempo máximo e % dentro do SLA (60 min).`],
  ["Custos operacionais", `Compara as planilhas de custos operacionais anexadas.`],

  /* ---------- Notas fiscais */
  ["Medições", `**Cada nota fiscal medida** (lançamento de um contrato): fornecedor, contrato, valor, datas e prazo.

- SLA: dias úteis da emissão da NF até a medição (feriados não contam). Acima do limite = atrasada e precisa de observação.
- Valor: valor da NF. Com rateio, aparece dividido por classe / centro de custo / projeto.
- Canceladas não entram em nenhum total.`],
  ["Contratos", `**Contratos com o valor contratado, o que já foi medido e o saldo.**

- Contratado + aditivo: valor total do contrato.
- Medições: soma das NFs lançadas (sem canceladas).
- Saldo atual = (contratado + aditivo) − medições.
- % usado = medições ÷ (contratado + aditivo).

Alertas: saldo baixo ou vigência perto do fim (limites em Prazos e alertas).`],
  ["Alertas dos contratos", `Limites que geram alerta nos contratos: % de saldo restante e dias até o fim da vigência.`],
  ["NFs medidas por mês", `**Quantidade de NFs medidas em cada mês**, colorida pelo SLA (no prazo, atrasada, sem data). Mostra se os atrasos estão concentrados em algum mês.`],
  ["Valor medido por mês", `Soma do valor das NFs medidas em cada mês (sem canceladas).`],
  ["Status do SLA de", `**% das medições feitas dentro do prazo** (dias úteis da emissão da NF até a medição) e % atrasadas.`],
  ["Medições atrasadas: tiveram observação?", `Das medições atrasadas, quantas têm o motivo do atraso preenchido. Toda medição atrasada deve ter observação.`],
  ["Fornecedores: NFs dentro do prazo de recebimento", `**Para cada fornecedor, quantas NFs chegaram até a data limite do mês** (cadastrada em Prazos e feriados) e quantas chegaram depois.`],
  ["Prazos de recebimento das NFs", `Data limite de cada mês para os fornecedores emitirem / enviarem as notas. É usada no indicador de fornecedores no prazo e no e-mail de solicitação.`],
  ["Feriados", `Feriados não contam como dia útil no cálculo do SLA das medições. Ao incluir ou excluir, os dias úteis são recalculados.`],
  ["Prazos das medições", `Número de dias úteis aceitos entre a emissão da NF e a medição (SLA). Usado no status de cada medição e no e-mail ao fiscal.`],
  ["E-mail da NF (interno, para o fiscal)", `Modelo do e-mail enviado ao fiscal do contrato quando uma NF é lançada.`],
  ["E-mail para fornecedores (solicitar NFs)", `Modelo do e-mail que pede as NFs do mês aos fornecedores, com a data limite.`],
  ["Importar planilha antiga", `Importa os dados da planilha antiga (EnviarEmailNF.xlsm): contratos, medições e prazos.`],

  /* ---------- Budget */
  [/^budget \d{4} por projeto/, `**Budget do ano por projeto e classe financeira.**

- Solicitado: valor pedido pela gestora.
- Aprovado: valor aprovado pela controladoria.
- Aprovado − solicitado: corte (negativo) ou acréscimo.
- Incorrido: medições de NF + pedidos de compra + contas de consumo (parte da Engenharia) lançados na linha.
- Saldo do aprovado = aprovado − incorrido.
- % do aprovado = incorrido ÷ aprovado. Acima de 100% = estourou.

Clique na classe para ver os meses e, no mês, cada lançamento.`],
  ["Incorrido por mês", `Quanto foi gasto em cada mês: medições de NF (inclui contas de consumo) + pedidos de compra, nas linhas filtradas.`],
  ["Incorrido acumulado no ano × aprovado e solicitado", `**O gasto somado mês a mês** contra as linhas fixas do aprovado e do solicitado do ano. Se a área passar da linha do aprovado, o budget estourou.`],
  ["Solicitado × aprovado × incorrido por projeto", `Para cada projeto: quanto foi pedido, quanto foi aprovado e quanto já foi gasto.`],
  ["Solicitado × aprovado × incorrido por centro de custo", `Para cada centro de custo: quanto foi pedido, quanto foi aprovado e quanto já foi gasto.`],
  ["Execução por classe financeira", `**% do aprovado já gasto em cada classe** (incorrido ÷ aprovado), as 15 mais executadas. Verde até 85%, amarelo até 100%, vermelho acima de 100% (estourou).`],
  ["Incorrido por classe financeira", `As 15 classes com mais gasto no ano, separando medições de NF e pedidos.`],
  ["Maiores fornecedores", `Os 12 fornecedores com mais valor no ano (medições + pedidos) nas linhas filtradas.`],
  ["Pedidos por motivo", `Valor dos pedidos de compra do ano somado por motivo.`],
  ["Maiores lançamentos por fornecedor", `Fornecedores com mais valor no ano. Clique no fornecedor para ver cada medição e pedido.`],
  ["Incorrido mensal por classe financeira", `Tabela classe × mês com o valor incorrido. Cor mais forte = mês com mais gasto. Passe o mouse para ver o valor exato.`],
  ["Valor por motivo", `Soma dos pedidos ativos (sem cancelados) por motivo.`],
  ["Pedidos por mês", `Valor dos pedidos emitidos em cada mês (sem cancelados).`],
  ["Valor por projeto", `Os 15 projetos com mais valor em pedidos ativos.`],
  ["Pedidos", `Lista dos pedidos de compra: nº, fornecedor, valor, classe, centro de custo e projeto. Pedidos entram no incorrido do budget; cancelados não.`],
  ["Centros de custo", `Centros de custo cadastrados (nº e descrição), usados no budget, nas NFs e no Suprimentos.`],
  ["Projetos", `Projetos cadastrados (nº, descrição e centro de custo ligado), usados no budget, nas NFs e no Suprimentos.`],
  ["Classes financeiras", `Classes financeiras cadastradas (nº e descrição): dizem em que tipo de gasto cada valor entra no budget.`],

  /* ---------- Documentos */
  ["Documentos", `**Documentos legais e certificações do parque** (AVCB, alvarás, laudos…), um por linha.

- Última renovação: a data mais recente da lista de renovações do documento.
- Próximo vencimento: última renovação + periodicidade (anual, semestral, a cada 2 anos…).
- Situação: Em dia, Vencendo (dentro do aviso), Vencido, ou Em processo (marcado por você em Editar enquanto a renovação anda).

Para renovar: botão **Renovar** > acrescente uma linha com a data (o arquivo é opcional). Para mudar nome, categoria, responsável, periodicidade ou situação: **Editar**.`],
  ["Vencidos", `Documentos com a data de vencimento já passada: renovar com urgência.`],
  [/^(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/, `Documentos que vencem neste mês.`],

  /* ---------- Dados / Equipe / Cadastro */
  ["Anexar relatórios de custos por evento", `Envie os Excel “Custos - Engenharia - EVENTO dd-mm-aa.xlsx”: o site lê itens (MDO, avarias, insumos), medidores, chamados e energia por hora e cria ou atualiza o evento. Pode arrastar vários arquivos de uma vez.`],
  ["Exportar Excel (base do Power BI)", `Baixa a base completa (eventos, itens, medidores, chamados) em Excel, no formato que o Power BI lê.`],
  ["Como ligar o Power BI no novo Excel", `Passo a passo para apontar o Power BI para o Excel exportado.`],
  ["Reorganizar planilhas anexadas", `Confere todos os anexos de uma vez e coloca cada um no evento certo, pelo nome do arquivo.`],
  ["Contas", `Pessoas com acesso ao site e o perfil de cada uma (administrador ou editor). Clique para editar ou desativar.`],
  ["Histórico de alterações", `Registro de quem fez o quê e quando (últimas 300 alterações).`],
  ["Itens", `Catálogo de itens (MDO, avarias, insumos) com valor unitário padrão, usado na leitura dos relatórios.`],
  ["Siglas de área (CHAMADOS CCO)", `Siglas usadas na planilha de chamados do CCO e a área que cada uma representa.`],
];
App.AJUDA = _ajudaCartoes.sort((a, b) => (b[0] instanceof RegExp ? 0 : String(b[0]).length) - (a[0] instanceof RegExp ? 0 : String(a[0]).length));

/* ================================================================== INDICADORES (quadros do topo) */
App.AJUDA_KPI = [
  ["Custo total", `Soma do custo de todos os eventos do filtro: medidores de consumo + mão de obra + avarias + insumos.`],
  [/^custo · /, `Soma, nos eventos do filtro, só dos componentes escolhidos no filtro.`],
  ["Média por evento", () => _pag() === "avarias" ? `Valor total de avarias ÷ número de eventos que tiveram avaria.` : `Custo total do filtro ÷ número de eventos do filtro.`],
  ["Medidores de consumo", `Soma de água, energia, gás e poço dos eventos do filtro. Embaixo: % do custo total.`],
  ["Mão de obra (MDO)", `Soma da mão de obra (quantidade × valor unitário dos técnicos e equipes) dos eventos do filtro. Embaixo: % do custo total.`],
  ["Avarias", `Soma das avarias (itens danificados × valor) dos eventos do filtro. Embaixo: % do custo total.`],
  ["Insumos", `Soma dos materiais usados nos eventos do filtro. Embaixo: % do custo total.`],
  ["Água", `Valor da água do(s) evento(s) (R$), pela conta da Sabesp. Nos jogos, a irrigação do gramado já faz parte desse valor: o "dos quais irrigação" mostra quanto é, sem somar de novo. Embaixo: m³ consumidos (leitura do medidor) e a média por evento.`],
  ["Energia elétrica", `Valor da energia do(s) evento(s) (R$). Embaixo: kWh consumidos (leitura do medidor) e a média por evento.`],
  ["Gás", `Valor do gás do(s) evento(s) (R$). Embaixo: m³ consumidos e a média por evento.`],
  ["Poço artesiano", `Valor do poço artesiano do(s) evento(s) (R$) = m³ medidos × tarifa do relatório. Embaixo: m³ consumidos.`],
  ["Técnicos transporte vertical", `Quantidade de técnicos de elevador e escada rolante no evento. Embaixo: valor (MDO).`],
  ["Técnico de medição acústica", `Quantidade de técnicos de medição acústica no evento. Embaixo: valor (MDO).`],
  ["Tempo médio", `Média do tempo de atendimento dos chamados (abertura até a execução).`],
  ["Dentro do SLA", `% dos chamados resolvidos em até 60 minutos.`],
  ["Tempo máximo", `Maior tempo de atendimento entre os chamados do filtro, com o tipo e o evento.`],
  ["Este evento", `Custo total deste evento.`],
  ["Média da categoria", `Custo médio dos outros eventos da mesma categoria.`],
  ["Diferença", `(custo deste evento − média da categoria) ÷ média da categoria.`],
  ["Valor total de avarias", `Soma de todas as avarias (quantidade × valor unitário) no filtro.`],
  ["Itens avariados", `Quantidade total de itens danificados (soma das quantidades). Embaixo: quantos tipos de item diferentes.`],
  ["Item de maior custo", `Item com o maior valor de avarias somado.`],
  ["Evento de maior custo", `Evento com o maior valor de avarias.`],
  ["Item mais avariado", `Item com a maior quantidade de unidades avariadas.`],
  ["Eficiência", `Tempo médio para execução dos chamados (abertura até a execução).`],
  ["Atendimento", `% dos chamados com tempo registrado que foram resolvidos dentro do SLA de 60 minutos.`],
  ["Chamados", `Número de chamados no filtro. Embaixo: número de eventos e média de chamados por evento.`],
  ["Diferença (B − A)", `Valor de B menos valor de A, em R$ e em %. Positivo = B maior.`],
  ["Solicitado", `Soma do valor pedido pela gestora nas linhas do budget filtradas.`],
  ["Aprovado", `Soma do valor aprovado pela controladoria. Embaixo: corte ou acréscimo em relação ao solicitado.`],
  ["Incorrido", `Tudo o que já foi gasto nas linhas filtradas: medições de NF (inclui as contas de consumo da Engenharia) + pedidos de compra.`],
  ["Saldo do aprovado", `Aprovado − incorrido (só das linhas com aprovado). Negativo = estourou. Embaixo: % usado e linhas estouradas.`],
  ["Pedidos", `Número de pedidos de compra no filtro (sem os cancelados).`],
  ["Valor total", `Soma dos pedidos sem os cancelados.`],
  ["Ticket médio", `Valor total ÷ número de pedidos (sem cancelados).`],
  ["Não calculados no budget", `Pedidos sem classe financeira ou com classe / centro de custo / projeto que não está no budget: não somam no incorrido.`],
  ["Medições", `Número de medições (NFs) no filtro, sem as canceladas.`],
  ["Valor medido", `Soma do valor das NFs medidas no filtro, sem as canceladas.`],
  [/^no prazo \(/, `% das medições feitas até o limite de dias úteis entre a emissão da NF e a medição.`],
  ["Atrasadas sem observação", `Medições atrasadas que ainda não têm o motivo do atraso preenchido.`],
  ["Contratos ativos", `Contratos não finalizados. Embaixo: quantos estão finalizados.`],
  ["Contratado + aditivo", `Soma do valor contratado + aditivos dos contratos ativos.`],
  ["Medido no período", `Soma das NFs medidas dentro do período do filtro.`],
  ["Medições (utilizado)", `Soma das NFs lançadas nos contratos ativos (sem canceladas).`],
  ["Saldo atual", `(Contratado + aditivo) − medições, somando os contratos ativos.`],
  ["Com alerta", `Contratos com saldo baixo ou vigência terminando (limites em Prazos e alertas).`],
  ["NFs medidas", `Número de NFs medidas no período.`],
  ["Valor total medido", `Soma do valor das NFs medidas. Embaixo: média por NF.`],
  [/^sla \d+ dias uteis/, `% das NFs medidas dentro do limite de dias úteis (emissão → medição).`],
  ["Atrasadas com observação", `% das medições atrasadas que têm o motivo preenchido.`],
  ["Fornecedores sempre no prazo", `Fornecedores que mandaram todas as NFs até a data limite do mês.`],
  ["Centros de custo", `Quantos centros de custo estão cadastrados.`],
  ["Projetos", `Quantos projetos estão cadastrados. Embaixo: quantos estão ligados a um centro de custo.`],
  ["Classes financeiras", `Quantas classes financeiras estão cadastradas.`],
  ["Contas ativas", `Pessoas que conseguem entrar no site. Embaixo: contas desativadas.`],
  ["Administradores", `Contas com perfil de administrador: além de editar, gerenciam a equipe.`],
  ["Alterações registradas", `Quantas alterações estão no histórico (as últimas 300).`],
  ["Documentos ativos", `Documentos que não foram arquivados.`],
  ["Vencidos", `Documentos com vencimento já passado.`],
  ["Vencendo", `Documentos que vencem dentro do prazo de aviso.`],
  ["Em dia", `Documentos que vencem depois do prazo de aviso.`],
  ["Em processo", `Documentos marcados como “Em processo de renovação” em Editar. Saem desse estado quando a renovação é registrada em Renovar.`],
];
App.AJUDA_KPI.sort((a, b) => (b[0] instanceof RegExp ? 0 : String(b[0]).length) - (a[0] instanceof RegExp ? 0 : String(a[0]).length));
