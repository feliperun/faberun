# ACHADOS-PRODUTO: campanha `legibilidade-relatorios`

Este livro reúne os achados de produto da implementação da escada de leitura nos relatórios do
faberun. Cada seção apresenta o **sintoma**, a **causa medida**, o **custo** e a **correção
sugerida**, e o motivo para classificar o caso como achado de produto.

Base: branch `legibilidade-relatorios`, a partir de `origin/main` @ `84f3af41` (release 0.31.0).

---

## 1. O degrau 4 (vídeo explicativo) fica fora do escopo por exigir chave de API ou compute local

- **Sintoma:** a escada de leitura do Karpathy tem quatro degraus — escrita controlada, diagramas,
  páginas web e vídeo explicativo. Os três primeiros têm caminho natural no faberun (disciplina de
  texto, SVG inline, HTML portátil). O quarto não tem: gerar vídeo exige chave de API de síntese de
  voz (ElevenLabs) ou compute local de fala, nenhum dos dois existente no produto.
- **Causa medida:** o próprio Karpathy aponta a dependência no degrau 4. O faberun hoje produz
  artefato durável (markdown, HTML, SVG) sem nenhuma chave de API de mídia e sem modelo de voz;
  adicionar vídeo introduziria uma dependência externa nova no caminho de leitura.
- **Custo:** nenhum dólar agora; o custo seria o de manter uma chave de ElevenLabs (ou o custo de
  compute de um modelo de fala local) por relatório, mais a política de onde essa chave vive nas
  máquinas da frota.
- **Correção sugerida:** quando (e se) o dono decidir que um relatório em vídeo vale a dependência,
  tratar como campanha própria — escolher o provedor de voz, decidir onde a chave fica (secret
  manager, nunca no repositório) e definir o texto-fonte do vídeo a partir do mesmo `renderReportMarkdown`.
- **Por que é achado de produto:** é uma decisão de dependência e de custo do dono, não uma
  implementação que cabe nesta campanha. Registrado para não ser silenciosamente esquecido nem
  silenciosamente implementado.

---

## Desfecho deste livro

Nenhum item foi implementado nesta campanha; o item 1 está aberto e aguarda decisão do dono sobre a
dependência de mídia. Os degraus 1 a 3 foram implementados no código (disciplina de termo, SVG do
grafo de trabalho e `report --html`), não como achado.
