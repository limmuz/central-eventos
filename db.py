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
CREATE INDEX IF NOT EXISTS ix_relogios_evento ON relogios(evento_id);
CREATE INDEX IF NOT EXISTS ix_chamados_evento ON chamados(evento_id);
CREATE INDEX IF NOT EXISTS ix_energia_evento ON energia_hora(evento_id);
"""


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
    return con


SIGLAS_PADRAO = {"OP": "OPERADOR", "E": "ELÉTRICA", "EL": "ELEVADOR", "ER": "ESCADA ROLANTE",
                 "AC": "AR CONDICIONADO", "H": "HIDRÁULICA", "C": "CIVIL"}


def init():
    with connect() as con:
        con.executescript(SCHEMA)
        # contas antigas: guias liberadas para cada pessoa (padrão = só o relatório pós-evento)
        cols = [r[1] for r in con.execute("PRAGMA table_info(usuarios)")]
        if "acessos" not in cols:
            con.execute("ALTER TABLE usuarios ADD COLUMN acessos TEXT DEFAULT '[\"relatorio\"]'")
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
