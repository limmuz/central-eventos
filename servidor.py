"""Sobe o site para a rede da empresa (servidor waitress).

Outras pessoas acessam pelo navegador:  http://NOME-DO-SEU-PC:8050
Se der problema, o motivo fica gravado em  servidor_erro.log  (na pasta do seu usuário).
"""
import faulthandler
import logging
import os
import socket
import sys
import traceback
from pathlib import Path

# log de diagnóstico fica na pasta do usuário
LOG = Path(os.environ.get("USERPROFILE") or Path.home()) / "servidor_erro.log"
_flog = open(LOG, "a", encoding="utf-8")   # acrescenta: reiniciar não apaga o registro do que deu errado
faulthandler.enable(file=_flog)          # se o Python travar "em silêncio", o motivo vai pro log
faulthandler.enable()                    # ... e também aparece na tela
logging.basicConfig(level=logging.INFO, format="  %(message)s")


def falhou(etapa):
    msg = traceback.format_exc()
    print(f"\n  ERRO em: {etapa}\n{msg}")
    _flog.write(f"ERRO em: {etapa}\n{msg}\n"); _flog.flush()
    print(f"  (detalhes salvos em {LOG})")
    input("  Pressione Enter para fechar...")
    sys.exit(1)


print("  Iniciando... (Python " + sys.version.split()[0] + ")", flush=True)
try:
    from waitress import serve
except ImportError:  # sem waitress: usa o servidor do Flask
    serve = None

try:
    print("  Carregando o site e o banco de dados...", flush=True)
    from app import CFG, app
except Exception:
    falhou("carregar o site (app.py / banco de dados)")

if __name__ == "__main__":
    porta = int(CFG.get("porta", 8050))
    nome = socket.gethostname()
    try:
        ip = socket.gethostbyname(nome)
    except OSError:
        ip = "seu-ip"
    # porta já ocupada? (outro servidor ainda aberto)
    with socket.socket() as s:
        if s.connect_ex(("127.0.0.1", porta)) == 0:
            print(f"\n  A porta {porta} já está em uso: provavelmente o site JÁ ESTÁ ABERTO em outra janela.")
            print(f"  Abra http://localhost:{porta} no navegador, ou feche a outra janela e rode de novo.")
            input("  Pressione Enter para fechar...")
            sys.exit(0)
    print("=" * 64)
    print("  Central de Engenharia no ar!")
    print(f"  Neste computador:   http://localhost:{porta}")
    print(f"  Para outros setores: http://{nome}:{porta}   ou   http://{ip}:{porta}")
    print("  Deixe esta janela aberta. Para parar: feche a janela ou Ctrl+C.")
    print("=" * 64, flush=True)
    try:
        if serve:
            serve(app, host="0.0.0.0", port=porta, threads=8)
        else:
            print("  (waitress não instalado: usando o servidor do Flask)")
            app.run(host="0.0.0.0", port=porta, threaded=True)
    except KeyboardInterrupt:
        print("  Servidor parado.")
        sys.exit(0)
    except Exception:
        falhou("iniciar o servidor")
    print("\n  O servidor parou sozinho sem mostrar erro.")
    print(f"  Mande para o suporte o arquivo {LOG}")
    input("  Pressione Enter para fechar...")
