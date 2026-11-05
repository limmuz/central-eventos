"""Banco de dados (SQLite) da Central de Engenharia (Relatório de eventos e Notas fiscais).

O arquivo do banco fica em data/relatorio.db. Para fazer backup, basta copiar a pasta data/.
"""
import sqlite3
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
ANEXOS_DIR = DATA_DIR / "anexos"
NF_DIR = DATA_DIR / "nf"
DB_PATH = DATA_DIR / "relatorio.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS eventos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    nome        TEXT NOT NULL,
    data        TEXT NOT NULL,              -- AAAA-MM-DD
    categoria   TEXT DEFAULT '',            -- SHOW / JOGO / PROJETO ESPECIAL
    genero      TEXT DEFAULT '',
    horario     TEXT DEFAULT '',
    publico     INTEGER,
    cliente     TEXT DEFAULT '',
    observacoes TEXT DEFAULT '',
    criado_em   TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(nome, data)
);

-- Itens de custo do evento: AVARIAS, MDO (mão de obra terceirizada/serviços) e INSUMOS
CREATE TABLE IF NOT EXISTS itens (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    evento_id   INTEGER NOT NULL REFERENCES eventos(id) ON DELETE CASCADE,
    tipo        TEXT NOT NULL,
    item        TEXT NOT NULL,
    valor_unit  REAL DEFAULT 0,
    qtd         REAL DEFAULT 0
);

-- Medidores de consumo: ÁGUA, GÁS, ELÉTRICA, POÇO
CREATE TABLE IF NOT EXISTS relogios (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    evento_id   INTEGER NOT NULL REFERENCES eventos(id) ON DELETE CASCADE,
    tipo        TEXT NOT NULL,
    consumo     REAL DEFAULT 0,
    valor       REAL DEFAULT 0,
    UNIQUE(evento_id, tipo)
);

-- Curva de energia por hora (kWh)
CREATE TABLE IF NOT EXISTS energia_hora (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    evento_id    INTEGER NOT NULL REFERENCES eventos(id) ON DELETE CASCADE,
    ordem        INTEGER,
    data_consumo TEXT,
    hora         TEXT,
    consumo      REAL
);

-- Chamados de manutenção (CCO)
CREATE TABLE IF NOT EXISTS chamados (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    evento_id   INTEGER NOT NULL REFERENCES eventos(id) ON DELETE CASCADE,
    descricao   TEXT NOT NULL,
    tipo        TEXT DEFAULT '',
    hora_inicio TEXT DEFAULT '',            -- HH:MM
    hora_final  TEXT DEFAULT ''
);

-- Tabela de preços
CREATE TABLE IF NOT EXISTS catalogo (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo        TEXT NOT NULL,
    item        TEXT NOT NULL,
    valor_unit  REAL DEFAULT 0,
    UNIQUE(tipo, item)
);

-- Planilhas/arquivos anexados ao evento (ex.: relatório de custos operacionais)
CREATE TABLE IF NOT EXISTS anexos (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    evento_id     INTEGER NOT NULL REFERENCES eventos(id) ON DELETE CASCADE,
    nome_original TEXT NOT NULL,
    arquivo       TEXT NOT NULL,
    tamanho       INTEGER,
    resumo_json   TEXT,
    enviado_em    TEXT DEFAULT (datetime('now','localtime'))
);

-- Siglas da coluna ÁREA da aba CHAMADOS CCO (editáveis no site)
CREATE TABLE IF NOT EXISTS siglas_area (
    sigla TEXT PRIMARY KEY,
    tipo  TEXT NOT NULL
);

-- Contas da equipe (quem pode editar de outros computadores)
CREATE TABLE IF NOT EXISTS usuarios (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    nome        TEXT NOT NULL,
    login       TEXT NOT NULL UNIQUE,
    senha_hash  TEXT NOT NULL,
    perfil      TEXT NOT NULL DEFAULT 'editor',   -- editor | admin
    ativo       INTEGER NOT NULL DEFAULT 1,
    criado_em   TEXT DEFAULT (datetime('now','localtime')),
    ultimo_acesso TEXT
);

-- Histórico de alterações (quem fez o quê)
CREATE TABLE IF NOT EXISTS historico (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    quando    TEXT DEFAULT (datetime('now','localtime')),
    usuario   TEXT,
    acao      TEXT,
    detalhe   TEXT
);

-- ===================== Medições de notas fiscais =====================
CREATE TABLE IF NOT EXISTS nf_contratos (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    numero            TEXT NOT NULL UNIQUE,
    fornecedor        TEXT NOT NULL,
    data_inicio       TEXT DEFAULT '',
    data_fim          TEXT DEFAULT '',
    saldo_contratado  REAL DEFAULT 0,
    aditivo           REAL DEFAULT 0,
    finalizado        INTEGER DEFAULT 0,
    observacao        TEXT DEFAULT '',
    criado_em         TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS nf_medicoes (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    numero_medicao    TEXT DEFAULT '',
    numero_documento  TEXT DEFAULT '',          -- número da NF
    data_emissao      TEXT DEFAULT '',
    data_vencimento   TEXT DEFAULT '',
    data_medicao      TEXT DEFAULT '',
    valor             REAL DEFAULT 0,
    contrato_id       INTEGER REFERENCES nf_contratos(id),
    anexo_arquivo     TEXT DEFAULT '',          -- arquivo guardado em data/nf
    anexo_nome        TEXT DEFAULT '',
    caminho_externo   TEXT DEFAULT '',          -- caminho do arquivo na planilha antiga (pasta de rede)
    observacao        TEXT DEFAULT '',
    status            TEXT DEFAULT 'PROSSEGUIU', -- PROSSEGUIU | PENDENTE | CANCELADA
    email_gerado_em   TEXT DEFAULT '',
    criado_em         TEXT DEFAULT (datetime('now','localtime'))
);

-- prazo para os fornecedores mandarem as NFs de cada mês
CREATE TABLE IF NOT EXISTS nf_prazos (
    mes              TEXT PRIMARY KEY,          -- AAAA-MM
    prazo            TEXT NOT NULL,             -- AAAA-MM-DD
    email_gerado_em  TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS nf_feriados (
    data       TEXT PRIMARY KEY,
    descricao  TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS nf_config (
    chave  TEXT PRIMARY KEY,
    valor  TEXT
);

-- itens (linhas) de um contrato: cada item pode ter centro de custo / projeto / classe financeira próprios
CREATE TABLE IF NOT EXISTS nf_contrato_itens (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    contrato_id     INTEGER NOT NULL REFERENCES nf_contratos(id) ON DELETE CASCADE,
    numero          TEXT DEFAULT '',            -- nº do item / linha do contrato
    descricao       TEXT DEFAULT '',
    budget_item_id  INTEGER,                    -- centro de custo + projeto + classe (bud_itens)
    ordem           INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_nf_itens_contrato ON nf_contrato_itens(contrato_id);

CREATE INDEX IF NOT EXISTS ix_nf_med_contrato ON nf_medicoes(contrato_id);
CREATE INDEX IF NOT EXISTS ix_nf_med_data ON nf_medicoes(data_medicao);
CREATE INDEX IF NOT EXISTS ix_nf_med_emissao ON nf_medicoes(data_emissao);
CREATE INDEX IF NOT EXISTS ix_nf_med_status ON nf_medicoes(status);
CREATE INDEX IF NOT EXISTS ix_eventos_data ON eventos(data);
CREATE INDEX IF NOT EXISTS ix_itens_tipo ON itens(tipo);
CREATE INDEX IF NOT EXISTS ix_anexos_evento ON anexos(evento_id);
CREATE INDEX IF NOT EXISTS ix_historico_quando ON historico(id);
CREATE INDEX IF NOT EXISTS ix_itens_evento ON itens(evento_id);
CREATE TABLE IF NOT EXISTS solicitacoes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo          TEXT NOT NULL,                     -- login | modulo
    usuario_id    INTEGER,                           -- pedido de módulo: quem pediu
    nome          TEXT,
    contato       TEXT,
    modulos       TEXT NOT NULL DEFAULT '[]',
    motivo        TEXT DEFAULT '',
    situacao      TEXT NOT NULL DEFAULT 'pendente',  -- pendente | aprovada | recusada
    ip            TEXT DEFAULT '',
    criado_em     TEXT DEFAULT (datetime('now','localtime')),
    resolvido_em  TEXT,
    resolvido_por TEXT
);

CREATE TABLE IF NOT EXISTS areas (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    nome  TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS ix_relogios_evento ON relogios(evento_id);
CREATE INDEX IF NOT EXISTS ix_chamados_evento ON chamados(evento_id);
CREATE INDEX IF NOT EXISTS ix_energia_evento ON energia_hora(evento_id);
"""


ao_conectar = None   # lixeira.preparar: anota o que uma exclusão apaga


def connect():
    DATA_DIR.mkdir(exist_ok=True)
    ANEXOS_DIR.mkdir(exist_ok=True)
    NF_DIR.mkdir(exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    # desempenho: mais páginas em memória e temporários em RAM. (Sem WAL: o banco fica numa pasta
    # de rede, e o modo WAL do SQLite não funciona em pasta de rede.)
    con.execute("PRAGMA cache_size = -16000")
    con.execute("PRAGMA temp_store = MEMORY")
    if ao_conectar:
        ao_conectar(con)
    return con


SIGLAS_PADRAO = {"OP": "OPERADOR", "E": "ELÉTRICA", "EL": "ELEVADOR", "ER": "ESCADA ROLANTE",
                 "AC": "AR CONDICIONADO", "H": "HIDRÁULICA", "C": "CIVIL"}


def _copia_antes_de_migrar():
    """Banco de uma versão anterior (sem a coluna de área): guarda uma cópia antes de alterar qualquer coisa."""
    if not DB_PATH.exists():
        return
    with sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=30) as ro:
        cols = [r[1] for r in ro.execute("PRAGMA table_info(usuarios)")]
    if cols and "area" not in cols:
        import datetime as dt
        destino = DATA_DIR / f"relatorio.antes_da_atualizacao_{dt.date.today():%Y-%m-%d}.db"
        if not destino.exists():
            with sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=30) as ro, sqlite3.connect(destino) as bk:
                ro.backup(bk)


def init():
    _copia_antes_de_migrar()
    with connect() as con:
        con.executescript(SCHEMA)
        # contas antigas: guias liberadas para cada pessoa (padrão = só o relatório pós-evento)
        cols = [r[1] for r in con.execute("PRAGMA table_info(usuarios)")]
        if "acessos" not in cols:
            con.execute("ALTER TABLE usuarios ADD COLUMN acessos TEXT DEFAULT '[\"relatorio\"]'")
        # visão de Budget e Notas fiscais por conta (NULL = tudo)
        if "visao" not in cols:
            con.execute("ALTER TABLE usuarios ADD COLUMN visao TEXT")
        # área de cada conta (separa os Documentos). Contas que já existiam entram em Engenharia, como os documentos antigos.
        if not con.execute("SELECT 1 FROM areas LIMIT 1").fetchone():
            con.executemany("INSERT INTO areas(nome) VALUES (?)", [("ENGENHARIA",), ("OPERAÇÕES",), ("SUSTENTABILIDADE",)])
        if "area" not in cols:
            con.execute("ALTER TABLE usuarios ADD COLUMN area TEXT DEFAULT ''")
            con.execute("UPDATE usuarios SET area='ENGENHARIA'")
        if "ip" not in [r[1] for r in con.execute("PRAGMA table_info(historico)")]:
            con.execute("ALTER TABLE historico ADD COLUMN ip TEXT DEFAULT ''")
        # dias úteis da medição ficam gravados (o site não recalcula tudo a cada consulta)
        if "busca" not in [r[1] for r in con.execute("PRAGMA table_info(nf_medicoes)")]:
            con.execute("ALTER TABLE nf_medicoes ADD COLUMN busca TEXT DEFAULT ''")   # texto sem acento p/ a busca
        if "dias_uteis" not in [r[1] for r in con.execute("PRAGMA table_info(nf_medicoes)")]:
            con.execute("ALTER TABLE nf_medicoes ADD COLUMN dias_uteis INTEGER")
            con.execute("UPDATE nf_medicoes SET dias_uteis = NULL")
            con.execute("INSERT OR REPLACE INTO nf_config(chave, valor) VALUES ('_recalcular', '1')")
        # budget: classe financeira da medição / do contrato e o item (linha) do contrato usado na medição
        for tabela, col in (("nf_medicoes", "budget_item_id"), ("nf_contratos", "budget_item_id"), ("nf_medicoes", "contrato_item_id"),
                           ("nf_medicoes", "pedido_id")):
            if col not in [r[1] for r in con.execute(f"PRAGMA table_info({tabela})")]:
                con.execute(f"ALTER TABLE {tabela} ADD COLUMN {col} INTEGER")
        if not con.execute("SELECT 1 FROM siglas_area LIMIT 1").fetchone():
            con.executemany("INSERT INTO siglas_area(sigla,tipo) VALUES (?,?)", SIGLAS_PADRAO.items())


def rows(cur):
    return [dict(r) for r in cur.fetchall()]


def criar_indices():
    """Índices das consultas mais pesadas (só aceleram, não mudam dados). Rodar depois que todos os módulos criaram as tabelas."""
    with connect() as con:
        for nome, tabela, colunas in (("ix_med_pedido", "nf_medicoes", "pedido_id"), ("ix_med_item", "nf_medicoes", "budget_item_id"),
                                      ("ix_nf_rateio_item", "nf_rateio", "item_id"), ("ix_previsto_item", "bud_previsto", "item_id, ano")):
            try:
                con.execute(f"CREATE INDEX IF NOT EXISTS {nome} ON {tabela}({colunas})")
            except sqlite3.OperationalError:
                pass   # tabela ainda não existe nesta versão
