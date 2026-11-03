"""Lê o PDF do pedido de compra (modelo "PEDIDO DE COMPRA" do sistema de compras) e devolve os campos.

Campos: nº do pedido (PC Nº), processo, emissão, projeto (nº + descrição), fornecedor (razão social e CNPJ),
valor total do pedido, descrição dos itens, cotação/RM, condição de pagamento e um motivo sugerido.
PDF escaneado (imagem, sem texto) não tem como ler: o site avisa e o pedido é preenchido à mão.
"""
import re
import sys
from io import BytesIO
from pathlib import Path

# pypdf vai junto com o site (bibliotecas/pypdf.zip), então não precisa instalar nada no computador do servidor
_LIBS = Path(__file__).resolve().parent / "bibliotecas" / "pypdf.zip"
if _LIBS.exists() and str(_LIBS) not in sys.path:
    sys.path.insert(0, str(_LIBS))

NUM = r"\d{1,3}(?:\.\d{3})*,\d{2}"

# palavras da descrição -> motivo do pedido (sugestão; a pessoa confere)
MOTIVOS_PALAVRAS = [   # (motivo, começos de palavra) — a primeira regra que bater vence
    ("SERVIÇO", ("SERVICO", "SERVIÇO", "MAO DE OBRA", "MÃO DE OBRA")),
    ("MATERIAL ELÉTRICA", ("ELETRIC", "ELÉTRIC", "LAMPADA", "LÂMPADA", "CABO", "DISJUNTOR", "TOMADA", "REATOR", "LUMINARIA", "LUMINÁRIA")),
    ("MATERIAL HIDRÁULICA", ("HIDRAUL", "HIDRÁUL", "TUBO", "REGISTRO", "VALVULA", "VÁLVULA", "TORNEIRA", "SIFAO", "SIFÃO", "BOMBA", "CONEXAO", "CONEXÃO")),
    ("MATERIAL MANUTENÇÃO CIVIL", ("CIMENTO", "TINTA", "ARGAMASSA", "PISO", "AREIA", "GESSO", "MASSA", "MADEIRA", "PARAFUSO", "REJUNTE")),
    ("OBRAS", ("OBRA", "REFORMA", "CONSTRU")),
    ("AVARIAS", ("AVARIA", "CONSERTO", "REPARO")),
]


def _br_num(t):
    try:
        return float(t.replace(".", "").replace(",", "."))
    except (AttributeError, ValueError):
        return None


def _iso(d):
    m = re.match(r"(\d{2})/(\d{2})/(\d{4})", d or "")
    return f"{m.group(3)}-{m.group(2)}-{m.group(1)}" if m else ""


def _campo(texto, rotulo):
    """Valor depois de 'rótulo :' até 2+ espaços ou fim da linha."""
    m = re.search(rotulo + r"\s*:\s*(.+?)(?:\s{2,}|$)", texto, re.M | re.I)
    return m.group(1).strip() if m else ""


def sugerir_motivo(texto):
    t = " " + re.sub(r"[^A-ZÀ-Ý0-9]+", " ", (texto or "").upper())
    for motivo, palavras in MOTIVOS_PALAVRAS:
        if any(" " + p in t for p in palavras):
            return motivo
    return ""


def ler_pedido(dados):
    """dados: bytes do PDF. Devolve dict com os campos achados e 'avisos' do que faltou."""
    try:
        from pypdf import PdfReader
    except ImportError:
        return {"erro": "Falta a biblioteca pypdf (pasta 'bibliotecas' do site)."}
    try:
        r = PdfReader(BytesIO(dados))
        layout = "\n".join((p.extract_text(extraction_mode="layout") or "") for p in r.pages)
        simples = "\n".join((p.extract_text() or "") for p in r.pages)
    except Exception as ex:  # PDF corrompido / protegido
        return {"erro": f"Não consegui abrir o PDF: {ex}"}
    if len(re.sub(r"\s", "", simples)) < 30:
        return {"erro": "Esse PDF não tem texto (parece escaneado). Preencha o pedido à mão."}

    out = {"avisos": []}
    m = re.search(r"PC\s*N[º°o]?\s*:\s*(\d+)", layout) or re.search(r"PEDIDO(?: DE COMPRA)?\s*N[º°o]\s*:?\s*(\d{4,})", layout, re.I)
    out["numero"] = m.group(1) if m else ""
    m = re.search(r"Processo\s*N[º°o]?\s*:\s*(\d+)", layout)
    out["processo"] = m.group(1) if m else ""
    m = re.search(r"Emiss[ãa]o\s*:\s*(\d{2}/\d{2}/\d{4})", layout)
    out["data_emissao"] = _iso(m.group(1)) if m else ""
    m = re.search(r"Projeto\s*:\s*(\d+)\s*-\s*(.+?)(?:\s{2,}|$)", layout, re.M)
    out["projeto_numero"], out["projeto_descricao"] = (m.group(1), m.group(2).strip().upper()) if m else ("", "")

    # fornecedor: bloco entre "DADOS DO FORNECEDOR" e "DADOS PARA FATURAMENTO" (o 2º bloco é a empresa que compra)
    i = layout.upper().find("DADOS DO FORNECEDOR")
    j = layout.upper().find("DADOS PARA FATURAMENTO")
    bloco = layout[i:j] if i >= 0 and j > i else layout
    out["fornecedor"] = _campo(bloco, r"Raz[ãa]o Social").upper()
    m = re.search(r"CNPJ\s*:\s*([\d./-]{14,18})", bloco)
    out["cnpj"] = m.group(1) if m else ""
    out["municipio"] = re.sub(r"\s+", " ", _campo(bloco, r"Munic[íi]pio"))

    # total do pedido: a linha de valores logo abaixo do rótulo "Total Pedido" (último número dela)
    out["valor"] = None
    linhas = layout.splitlines()
    for k, ln in enumerate(linhas):
        if "Total Pedido" in ln:
            for prox in linhas[k + 1:k + 4]:
                nums = re.findall(NUM, prox)
                if nums:
                    out["valor"] = _br_num(nums[-1])
                    break
            break
    if out["valor"] is None:
        m = re.search(r"Total Pedido[\s\S]{0,200}?(" + NUM + r")", simples)
        out["valor"] = _br_num(m.group(1)) if m else None

    # descrição dos itens: textos entre o cabeçalho da tabela e "Base calc."
    desc = []
    ini = next((k for k, ln in enumerate(linhas) if "AUTORIZAMOS" in ln.upper()), None)
    fim = next((k for k, ln in enumerate(linhas) if "Base calc" in ln), None)
    if ini is not None and fim and fim > ini:
        cab = {"CÓDIGO", "CODIGO", "QUANTIDADE", "UNIDADE", "VALOR", "UNITÁRIO", "UNITARIO", "DESCONTO", "ALÍQUOTA", "ALIQUOTA",
               "ICMS", "IPI", "ITEM", "VALOR TOTAL"}
        for ln in linhas[ini + 1:fim]:
            if "Descrição do Produto" in ln or "Unitário" in ln:
                continue
            celulas = [c for c in re.split(r"\s{2,}", ln.strip()) if c]
            if celulas and not any(re.fullmatch(r"[\d.,]+", c) for c in celulas) and len(celulas) <= 3:
                desc.append(" ".join(celulas))                          # continuação da descrição
                continue
            for cel in celulas:
                cel = re.sub(r"^[\d.,\s]+", "", cel).strip()          # números colados no começo
                cel = re.sub(r"(\s+[\d.,]+)+$", "", cel).strip()       # números no fim
                if len(re.sub(r"[^A-Za-zÀ-ÿ]", "", cel)) >= 4 and cel.upper() not in cab:
                    desc.append(cel)
    out["descricao"] = re.sub(r"\s+", " ", " ".join(desc)).strip()[:500]
    out["cotacao"] = _campo(layout, r"Cota[çc][ãa]o")
    m = re.search(r"RM\s*(\d+)", out["cotacao"])
    out["rm"] = m.group(1) if m else ""
    out["cond_pagto"] = _campo(layout, r"Cond\.?\s*Pagto")
    out["motivo"] = sugerir_motivo(out["descricao"])

    for campo, nome in (("numero", "nº do pedido"), ("fornecedor", "fornecedor"), ("data_emissao", "data de emissão"), ("valor", "valor total")):
        if not out.get(campo):
            out["avisos"].append(f"Não achei o {nome} no PDF.")
    return out
