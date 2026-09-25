# sap-workflow-adt — instalação no Claude Desktop (Windows)

O arquivo `bundle/sap-workflow-adt.js` é o servidor MCP completo num único arquivo
(sem `node_modules`). Basta o Node.js 18+ instalado.

## 1. Configurar no Claude Desktop

Claude Desktop → **Settings → Developer → Edit Config** (abre `claude_desktop_config.json`).
Copie a entrada do servidor atual (`sap-training`) e crie outra, trocando só o caminho do arquivo:

```json
"sap-workflow": {
  "command": "node",
  "args": ["C:\\Users\\gabis\\Documents\\sap-workflow-adt\\bundle\\sap-workflow-adt.js"],
  "env": {
    "SAP_URL": "<mesmo valor do sap-training>",
    "SAP_USER": "<mesmo valor>",
    "SAP_PASSWORD": "<mesmo valor>",
    "SAP_CLIENT": "100",
    "SAP_LANGUAGE": "EN",
    "NODE_TLS_REJECT_UNAUTHORIZED": "0"
  }
}
```

Reinicie o Claude Desktop. Depois de validar, remova a entrada `sap-training` para não ter
as mesmas ferramentas duplicadas (o sap-workflow-adt tem todas as do dassian-adt + as novas).

## 2. Variáveis opcionais

| Variável | Padrão | Uso |
|---|---|---|
| `CLASSRUN_WAIT_MS` | `90000` | Tempo máximo esperando a classe temporária ficar visível no servidor de aplicação (abap_run) |

## 3. Desenvolvimento

```bash
npm install          # uma vez
npm test             # testes unitários (sem SAP)
npm run build        # dist/ (tsc)
npm run bundle       # bundle/sap-workflow-adt.js (esbuild) — é o que o Claude Desktop executa
```

Para receber atualizações do projeto original: `git fetch upstream && git merge upstream/main`.
