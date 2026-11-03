"""Cria um banco de demonstração com DADOS 100% FICTÍCIOS (eventos, chamados, notas fiscais e documentos).

Uso:  python seed_demo.py
Apaga o banco atual (data/relatorio.db) e cria um novo, só com dados de exemplo.
"""
import random, sqlite3, datetime as dt
from pathlib import Path

BANCO = Path(__file__).resolve().parent / "data" / "relatorio.db"
if BANCO.exists():
    BANCO.unlink()
import app  # noqa: E402,F401  (ao importar, o site cria todas as tabelas no banco novo)

random.seed(2026)
con = sqlite3.connect(BANCO)
cur = con.cursor()

eventos = [
    ("SHOW POP ESTRELA", "SHOW", "POP"), ("TIME A x TIME B", "JOGO", "BRASILEIRÃO"),
    ("FESTIVAL DE ROCK", "SHOW", "ROCK"), ("TIME A x TIME C", "JOGO", "COPA DO BRASIL"),
    ("NOITE SERTANEJA", "SHOW", "SERTANEJO"), ("TIME A x TIME D", "JOGO", "LIBERTADORES"),
    ("ENCONTRO MPB", "SHOW", "MPB"), ("TIME A x TIME E", "JOGO", "BRASILEIRÃO"),
    ("BANDA EXEMPLO", "SHOW", "ROCK"), ("TIME A x TIME F", "JOGO", "BRASILEIRÃO"),
    ("FESTA DO SAMBA", "SHOW", "SAMBA"), ("TIME A x TIME G", "JOGO", "LIBERTADORES"),
    ("TURNÊ INTERNACIONAL", "SHOW", "POP"), ("TIME A x TIME H", "JOGO", "BRASILEIRÃO"),
    ("CAMPEONATO DE GAMES", "PROJETO ESPECIAL", "CAMPEONATO"), ("SHOW INFANTIL", "SHOW", "INFANTIL"),
]
avarias = [("CADEIRA ARQUIBANCADA", 1450), ("DISPENSER SABÃO", 280), ("ASSENTO SANITÁRIO", 320),
           ("TORNEIRA AUTOMÁTICA", 690), ("LÂMPADA LED", 85), ("FECHADURA PORTA", 240), ("ESPELHO BANHEIRO", 410)]
mdo = [("TÉCNICO ELEVADOR", 720), ("TÉCNICO ESCADA ROLANTE", 720), ("ELETRICISTA PLANTÃO", 540), ("ENCANADOR PLANTÃO", 520)]
tipos_ch = ["HIDRÁULICA", "ELÉTRICA", "OPERADOR", "CIVIL", "ESCADA ROLANTE", "ELEVADOR", "AR CONDICIONADO"]
locais = ["Banheiro setor norte", "Banheiro setor sul", "Corredor nível 2", "Camarote 14", "Bar oeste", "Rampa leste",
          "Vestiário visitante", "Sala de imprensa", "Bilheteria 3", "Portão 7"]
problemas = {"HIDRÁULICA": "vazamento na torneira", "ELÉTRICA": "lâmpadas apagadas", "OPERADOR": "apoio ao público",
             "CIVIL": "piso solto", "ESCADA ROLANTE": "escada parada", "ELEVADOR": "elevador travado",
             "AR CONDICIONADO": "ar sem refrigerar"}

d0 = dt.date(2026, 3, 7)
for k, (nome, cat, gen) in enumerate(eventos):
    data = (d0 + dt.timedelta(days=12 * k + random.randint(0, 4))).isoformat()
    pub = random.randint(28000, 46000) if cat != "PROJETO ESPECIAL" else random.randint(8000, 15000)
    cur.execute("INSERT INTO eventos(nome,data,categoria,genero,horario,publico,cliente,observacoes) VALUES (?,?,?,?,?,?,?,?)",
                (nome, data, cat, gen, "21:00" if cat == "SHOW" else "19:30", pub, "Cliente Exemplo", "Dados fictícios"))
    eid = cur.lastrowid
    f = 1.0 if cat == "SHOW" else 0.6
    for item, v in random.sample(avarias, 4):
        cur.execute("INSERT INTO itens(evento_id,tipo,item,valor_unit,qtd) VALUES (?,?,?,?,?)", (eid, "AVARIAS", item, v, random.randint(1, 6)))
    for item, v in random.sample(mdo, 3):
        cur.execute("INSERT INTO itens(evento_id,tipo,item,valor_unit,qtd) VALUES (?,?,?,?,?)", (eid, "MDO", item, v, round(random.randint(4, 14) * f)))
    agua = random.uniform(180, 420) * f; gas = random.uniform(120, 300) * f; ele = random.uniform(14000, 30000) * f; poco = random.uniform(90, 220) * f
    for tipo, c, tarifa in (("ÁGUA", agua, 62), ("GÁS", gas, 7.2), ("ELÉTRICA", ele, 0.55), ("POÇO", poco, 0)):
        cur.execute("INSERT INTO relogios(evento_id,tipo,consumo,valor) VALUES (?,?,?,?)", (eid, tipo, round(c, 1), round(c * tarifa, 2)))
    base = ele / 24
    for h in range(24):
        pico = 2.6 if 18 <= h <= 23 else (1.4 if 14 <= h < 18 else 0.6)
        cur.execute("INSERT INTO energia_hora(evento_id,ordem,data_consumo,hora,consumo) VALUES (?,?,?,?,?)",
                    (eid, h + 1, data, f"{h:02d}:00", round(base * pico * random.uniform(0.85, 1.15), 1)))
    for _ in range(random.randint(18, 40)):
        t = random.choices(tipos_ch, weights=[30, 22, 18, 12, 8, 6, 5])[0]
        hi = dt.datetime(2026, 1, 1, random.randint(16, 23), random.randint(0, 59))
        hf = hi + dt.timedelta(minutes=random.choice([6, 10, 15, 20, 25, 35, 50, 75]))
        cur.execute("INSERT INTO chamados(evento_id,descricao,tipo,hora_inicio,hora_final) VALUES (?,?,?,?,?)",
                    (eid, f"{random.choice(locais)} – {problemas[t]}", t, hi.strftime("%H:%M"), hf.strftime("%H:%M")))

for item, v in avarias:
    cur.execute("INSERT OR IGNORE INTO catalogo(tipo,item,valor_unit) VALUES ('AVARIAS',?,?)", (item, v))
for item, v in mdo:
    cur.execute("INSERT OR IGNORE INTO catalogo(tipo,item,valor_unit) VALUES ('MDO',?,?)", (item, v))

# Notas fiscais
fornecedores = ["Manutenção Exemplo Ltda", "Elevadores Demo S.A.", "Limpeza Modelo Serviços", "Clima Fictício Engenharia",
                "Hidráulica Teste ME", "Segurança Demo Ltda"]
for i, forn in enumerate(fornecedores):
    cur.execute("INSERT INTO nf_contratos(numero,fornecedor,data_inicio,data_fim,saldo_contratado,aditivo,observacao) VALUES (?,?,?,?,?,?,?)",
                (f"CT-DEMO-{i+1:03d}", forn, "2026-01-01", "2026-12-31", random.choice([120000, 180000, 240000, 360000]), 0, "Contrato fictício"))
    cid = cur.lastrowid
    for m in range(1, 11):
        st = "PROSSEGUIU" if m < 10 else random.choice(["PENDENTE", "PROSSEGUIU"])
        cur.execute("""INSERT INTO nf_medicoes(numero_medicao,numero_documento,data_emissao,data_vencimento,data_medicao,valor,contrato_id,status,observacao)
                       VALUES (?,?,?,?,?,?,?,?,?)""",
                    (f"{m:02d}/2026", str(1000 + i * 100 + m), f"2026-{m:02d}-05", f"2026-{m:02d}-28", f"2026-{m:02d}-10",
                     round(random.uniform(6000, 24000), 2), cid, st, "Medição fictícia"))

# Documentos com vencimento
documentos = [("Licença de funcionamento (exemplo)", "ALVARÁ DA ARENA", "Prefeitura (exemplo)", 40),
        ("Auto de vistoria do corpo de bombeiros (exemplo)", "ALVARÁ DA ARENA", "Bombeiros (exemplo)", 120),
        ("Laudo elétrico (exemplo)", "AUDITORIA INTERNA", "Engenharia", 15),
        ("Plano de manutenção do ar-condicionado (exemplo)", "AUDITORIA INTERNA", "Engenharia", 200),
        ("Certificado de potabilidade da água (exemplo)", "AUDITORIA INTERNA", "Laboratório (exemplo)", -5),
        ("Laudo de segurança estrutural (exemplo)", "ALVARÁ DA ARENA", "Engenharia", 300)]
hoje = dt.date.today()
for nome, cat, org, dias in documentos:
    cur.execute("""INSERT INTO doc_documentos(nome,categoria,numero,orgao,responsavel,data_renovacao,data_vencimento,aviso_dias,observacao)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (nome, cat, f"DEMO-{random.randint(1000,9999)}", org, "Responsável Demo",
                 (hoje - dt.timedelta(days=365 - dias)).isoformat(), (hoje + dt.timedelta(days=dias)).isoformat(), 60, "Documento fictício"))
con.commit()
print(f"Banco de demonstração criado: {cur.execute('select count(*) from eventos').fetchone()[0]} eventos, "
      f"{cur.execute('select count(*) from chamados').fetchone()[0]} chamados, {len(fornecedores)} contratos e {len(documentos)} documentos.")
