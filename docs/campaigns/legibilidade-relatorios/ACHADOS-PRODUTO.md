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
- **Desfecho (02/10/2026):** implementado nativo em `report --video` (`src/report/report-video.mjs`,
  commit `d4e95a44`). O degrau 4 usa a chave ElevenLabs do ambiente ford (`ELEVENLABS_API_KEY` +
  `ELEVENLABS_VOICE`), lidas do ambiente, nunca gravadas; a cena é SVG programático do grafo de
  trabalho (nó a nó, estilo 3Blue1Brown), rasterizado com `rsvg-convert` e montado com `ffmpeg` em
  torno da narração. Sem manim: nenhuma máquina da frota o tem.
- **Por que é achado de produto:** era uma decisão de dependência e de custo do dono. Virou
  implementação; a dependência que resta é de máquina — `rsvg-convert` e `ffmpeg` precisam existir
  na máquina que gera o vídeo (o Mac tem; o frb-linux tem só `ffmpeg`), e a chave precisa estar no
  ambiente.

---

## Desfecho deste livro

Os quatro degraus da escada foram implementados nativo no código: disciplina de termo (degrau 1),
SVG do grafo de trabalho e `report --html` (degraus 2 e 3) e o vídeo animado com narração ElevenLabs
(degrau 4). O item 1 era o único aberto e foi resolvido pela implementação; a dependência de
máquina que resta (`rsvg-convert` + `ffmpeg` na máquina que gera o vídeo, e a chave no ambiente)
está registrada no próprio item.
