# Writes tests/fixtures/autoRoute/tokenizer_reference.json: Hugging Face tokenizers' ids for the BGE tokenizer on probe texts.
"""Usage: python -I tokenizer-reference.py <pinned bge/tokenizer.json> <numeric_reference.json> <out.json>

Needs the `tokenizers` package. `npm run auto-route:parity` compares electron/autoRoute/squilla/tokenizer.cjs with
these ids on the real tokenizer.json (encode(text, add_special_tokens=False), as OpenSquilla's runtime calls it).
"""
import json
import sys
from pathlib import Path

from tokenizers import Tokenizer

EXTRA = [
    "",
    "[EMPTY]",
    "literal [CLS] and [SEP] and [MASK] tokens[PAD]",
    "UPPER lower MiXeD ÀÉÎ accents naïve",
    "supercalifragilisticexpialidocious" * 4,
    "x" * 120,
    "¿Qué? ¡Sí! «quotes» — dash… ellipsis",
    "数学：1+1=2；英文：one+one=two。",
    "𠀀𪜀 extension B/C characters and 〇",
    "\u0000null�replacement­soft hyphen﻿bom",
    "tabs\tand\nnewlines\r\nand\u000bvertical",
    "emoji 😀👍🏽 and symbols ©®™ ∑∫√",
    "code: def f(x): return x[1] # comment",
]


def main():
    tok = Tokenizer.from_file(sys.argv[1])
    texts = [c["input"]["current_request"] for c in json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))["cases"]] + EXTRA
    cases = [{"text": t, "ids": tok.encode(t, add_special_tokens=False).ids} for t in texts]
    Path(sys.argv[3]).write_text(json.dumps({"source": "tokenizers " + __import__("tokenizers").__version__, "cases": cases}, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
