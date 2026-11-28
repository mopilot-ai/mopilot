# Writes tests/fixtures/autoRoute/numeric_reference.json: OpenSquilla's own numeric88 for inputs that probe Python semantics.
"""Usage: python -I numeric-reference.py <dir holding OpenSquilla's lightgbm_model/_vendor/features as a package> <out.json>

The package needs numeric.py, registry.py, text.py and __init__.py from the pinned commit
(src/opensquilla/squilla_router/lightgbm_model/_vendor/features); numpy is the only dependency.
The JS port (electron/autoRoute/squilla/numeric.cjs) must reproduce every vector exactly.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(sys.argv[1]).resolve().parent))
from features.numeric import extract_numeric88  # noqa: E402

TEXTS = [
    "Deploy to production: fix the bug in src/app/main.ts and lib/util.py and docs/a.md",
    "```bash\n$ npm test\n```\n> run it",
    '{"key": 1} and {\'k\': 2}',
    "name: value\nother_key:  x",
    "a,b,c\nd,e",
    "| x | y |",
    "- item\n* other\n  - nested",
    "1. one\n2) two\n3、three",
    "see https://example.com/x?y=1 and http://a.b",
    "2026-01-01 10:00 one\n2026-01-01 10:01 two\n2026-01-01T10:02 three\n",
    "INFO start\n[WARN] mid\nERROR end\n",
    'Traceback (most recent call last)\n  File "x.py", line 12',
    '必须 "quoted" text？！ \'single\' `tick`',
    "中文 and English mixed text 中文",
    "x" * 300,
    "```\ncode\n```" + "y" * 1200,
    "line separator para\u0085next",
    "名字: 值\n変数：x\n٣. Arabic digit step\n१२३४-१२-१२ १०:१० devanagari",
    "tab\tsep　ideographic nbsp em",
    "\u001ccontrol\u001fseps and zero​width",
    "path ./rel/x.js, (paren/y.ts) 'q/z.md' `b/c.d` é/ü.txt _u/v.w",
    "How to implement a function? Explain why. Compare trade-off vs tradeoff, analyse & analyze",
    "Café\r\nPlease compare A and B.\rok",
    "ＪＳＯＮ only return schema; 只返回 YAML",
    "继续",
    "go on",
    "next steps?",
    "😀 emoji 👍🏽 count",
]
PREVIOUS = [
    "",
    "Could you clarify which file? I cannot help. not sure. `inline code` 1. step one",
    "能否请 提供更多信息？抱歉，我不能。作为AI 我不确定。\n1、第一步",
    "```py\nprint(1)\n```",
    "Here is the answer.",
]
USAGES = [
    {},
    {"input_tokens": 2048, "output_tokens": 300, "reasoning_tokens": 120, "cached_tokens": 1000, "duration_ms": 8500},
    {"input_tokens": "2_000", "output_tokens": "1e3", "reasoning_tokens": "inf", "cached_tokens": 5000, "duration_ms": False},
    {"input_tokens": 0, "output_tokens": -5, "reasoning_tokens": None, "cached_tokens": "abc"},
]
HISTORIES = [
    [],
    [{"tier": "C1", "difficulty": 1.1, "margin": 0.4}, {"tier": "C2", "difficulty": 2.1, "margin": 0.2}],
    [{"tier": "C0", "difficulty": 0}, {"tier": "C2", "difficulty": 2}, {"tier": "C0", "difficulty": 0}, {"tier": "C2", "difficulty": 2}],
    [{"tier_id": "r3", "difficulty_score": "1.5"}, {"route_class": "C3", "margin": "x"}],
]


def main():
    cases = []
    for i, text in enumerate(TEXTS):
        payload = {
            "current_request": text,
            "history_user": [TEXTS[(i + 3) % len(TEXTS)], "  ", TEXTS[(i + 5) % len(TEXTS)]][: i % 4],
            "previous_answer": PREVIOUS[i % len(PREVIOUS)],
            "previous_usage": USAGES[i % len(USAGES)],
            "route_history": HISTORIES[i % len(HISTORIES)],
        }
        if i % 5 == 4:
            payload["context"] = {"context_tokens_est": 3000 + i}
        cases.append({"input": payload, "numeric88": [float(v) for v in extract_numeric88(payload)]})
    Path(sys.argv[2]).write_text(json.dumps({"source": "OpenSquilla 96ad3e4 lightgbm_model/_vendor/features/numeric.py", "cases": cases}, ensure_ascii=False, indent=0) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
