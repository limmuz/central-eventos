"""Tabela dinâmica (PivotTable) de verdade no Excel, montada com as classes de pivot do openpyxl.

O cache leva todos os registros (o Excel mostra sem precisar recalcular) e refreshOnLoad (atualiza ao abrir).
Linhas em níveis (ex.: ITEM > EVENTO): cada grupo abre e fecha com o + / − do Excel, como as listas do site.
"""
import datetime as dt

from openpyxl.pivot.cache import CacheDefinition, CacheField, CacheSource, SharedItems, WorksheetSource
from openpyxl.pivot.fields import DateTimeField, Index, Missing, Number, Text
from openpyxl.pivot.record import Record, RecordList
from openpyxl.pivot.table import (DataField, FieldItem, Location, PageField, PivotField, PivotTableStyle, RowColField,
                                  RowColItem, TableDefinition)
from openpyxl.utils import get_column_letter

_CID = 100
_N = {"sum": 4, "count": 3, "average": 4}   # formato: #,##0.00 / #,##0


def _tipo(valores):
    v = [x for x in valores if x not in (None, "")]
    if v and all(isinstance(x, (dt.date, dt.datetime)) for x in v):
        return "data"
    if v and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in v):
        return "num"
    return "texto"


def _dt(x):
    return x if isinstance(x, dt.datetime) else dt.datetime(x.year, x.month, x.day)


def criar(ws, origem, cab, linhas, linha_cab, linhas_campos, valores, filtros=(), nome="Dinamica", ancora_linha=4,
          recolhido=True, cache=None):
    """ws: aba onde a tabela dinâmica fica · origem: aba dos dados (cabeçalho na linha linha_cab, dados logo abaixo)
    linhas_campos: índices das colunas que vão nas linhas (1º = nível de cima) · valores: [(índice, 'sum'|'count'|'average', rótulo)]
    filtros: índices das colunas que viram filtro no topo da tabela. Devolve o cache (para reaproveitar em outra tabela)."""
    ncol, nlin = len(cab), len(linhas)
    cols = [[l[j] if j < len(l) else None for l in linhas] for j in range(ncol)]
    tipos = [_tipo(c) for c in cols]
    eixo = set(linhas_campos) | set(filtros)
    itens = {}
    if True:   # um cache por tabela dinâmica (o Excel não se confunde com caches compartilhados)
        campos = []
        for j, nomec in enumerate(cab):
            c, t = cols[j], tipos[j]
            if t == "texto":
                uniq = sorted({("" if v is None else str(v)) for v in c}, key=lambda s: s.upper())
                itens[j] = {u: k for k, u in enumerate(uniq)}
                si = SharedItems(count=len(uniq))
                si._fields = [Text(v=u) for u in uniq]
            elif t == "num":
                v = [x for x in c if x is not None]
                si = SharedItems(containsSemiMixedTypes=False, containsString=False, containsNumber=True,
                                 containsInteger=all(float(x).is_integer() for x in v) or None,
                                 containsBlank=(len(v) < nlin) or None, minValue=min(v) if v else 0, maxValue=max(v) if v else 0)
            else:
                v = [_dt(x) for x in c if x is not None]
                si = SharedItems(containsSemiMixedTypes=False, containsNonDate=False, containsDate=True, containsString=False,
                                 containsBlank=(len(v) < nlin) or None, minDate=min(v) if v else None, maxDate=max(v) if v else None)
            campos.append(CacheField(name=nomec, numFmtId=0, sharedItems=si))
        regs = []
        for l in linhas:
            f = []
            for j in range(ncol):
                v = l[j] if j < len(l) else None
                if tipos[j] == "texto":
                    f.append(Index(v=itens[j]["" if v is None else str(v)]))
                elif v is None:
                    f.append(Missing())
                elif tipos[j] == "num":
                    f.append(Number(v=v))
                else:
                    f.append(DateTimeField(v=_dt(v)))
            regs.append(Record(_fields=f))
        ref = f"A{linha_cab}:{get_column_letter(ncol)}{linha_cab + max(nlin, 1)}"
        cache = CacheDefinition(refreshOnLoad=True, refreshedBy=nome, createdVersion=6, refreshedVersion=6, minRefreshableVersion=3,
                                recordCount=nlin, cacheSource=CacheSource(type="worksheet", worksheetSource=WorksheetSource(ref=ref, sheet=origem)),
                                cacheFields=campos)
        cache.records = RecordList(r=regs)
        cache._itens = itens
    itens = cache._itens

    pfs = []
    for j in range(ncol):
        if j in eixo and j in itens:
            n = len(itens[j])
            fi = [FieldItem(x=k, sd=(False if (recolhido and j in linhas_campos[:-1]) else None))
                  for k in range(n)] + [FieldItem(t="default", sd=None)]
            pf = PivotField(axis="axisRow" if j in linhas_campos else "axisPage", showAll=False, items=fi, compact=True, outline=True)
        else:
            pf = PivotField(showAll=False, dataField=True if any(v[0] == j for v in valores) else None)
        pfs.append(pf)

    nval = len(valores)
    ini = ancora_linha + (len(filtros) + 1 if filtros else 0)
    loc = Location(ref=f"A{ini}:{get_column_letter(1 + nval)}{ini + 2}", firstHeaderRow=1 if nval == 1 else 0,
                   firstDataRow=1 if nval == 1 else 1, firstDataCol=1,
                   rowPageCount=len(filtros) or None, colPageCount=1 if filtros else None)
    global _CID
    if not hasattr(cache, "_cid"):
        _CID += 1
        cache._cid = _CID
    t = TableDefinition(name=nome, cacheId=cache._cid, dataCaption="Valores", updatedVersion=6, minRefreshableVersion=3, createdVersion=6,
                        applyNumberFormats=False, applyBorderFormats=False, applyFontFormats=False, applyPatternFormats=False,
                        applyAlignmentFormats=False, applyWidthHeightFormats=True, useAutoFormatting=True, itemPrintTitles=True,
                        indent=1, outline=True, outlineData=True, multipleFieldFilters=False, rowHeaderCaption=cab[linhas_campos[0]],
                        location=loc, pivotFields=pfs, rowFields=[RowColField(x=j) for j in linhas_campos],
                        colFields=[RowColField(x=-2)] if nval > 1 else [],
                        colItems=[RowColItem(i=k, x=[Index(v=k)] if k else [Index()]) for k in range(nval)] if nval > 1 else [RowColItem()],
                        pageFields=[PageField(fld=j, hier=-1) for j in filtros],
                        dataFields=[DataField(name=rot, fld=j, subtotal=sub, baseField=0, baseItem=0, numFmtId=_N[sub]) for j, sub, rot in valores],
                        pivotTableStyleInfo=PivotTableStyle(name="PivotStyleMedium9", showRowHeaders=True, showColHeaders=True,
                                                            showRowStripes=False, showColStripes=False, showLastColumn=True))
    t.cache = cache
    ws.add_pivot(t)
    return cache
