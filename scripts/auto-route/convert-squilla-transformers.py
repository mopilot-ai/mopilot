# Converts OpenSquilla's frozen sklearn transformers to inert JSON/float files without executing their pickled code.
"""Usage: python -I convert-squilla-transformers.py <dir with the four verified joblib files> <output dir>

Only numpy array reconstruction is resolved for real; every sklearn and router_training class is
replaced by an inert stub that records its pickled state, so no code from the files runs.
Needs numpy and joblib (pure Python) in a throwaway virtualenv; scikit-learn is not imported.
"""
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from joblib.numpy_pickle import NumpyArrayWrapper, NumpyUnpickler

EXPECTED = {
    "pca64.joblib": "86dafb29f5fe068b4908db09e7dd4bb75a907cce9826d7c4648660dda16b78b4",
    "svd100.joblib": "76ecc02ff3dfa290a7433a5bb3fcdbe0a03945239d5bfff9cc4e5a1c6b6f30dc",
    "tfidf_char_wb_2_4.joblib": "95c8546d13686519c07c0387687e5146727e9eef822b4114ec629153a85f1312",
    "standard_scaler88.joblib": "a21f68eafb1540d7c97792ca23b1b079e5de427cc2bcf0300e6b5370d90f4ff5",
}


class Stub:
    """Stands in for a pickled class: records state, runs nothing."""

    def __init__(self, *args, **kwargs):
        self.args = args

    def __setstate__(self, state):
        self.state = state


STUBBED = {
    ("router_training.features.runtime", "SklearnPCA64Projector"),
    ("router_training.features.runtime", "SklearnSVD100Projector"),
    ("router_training.features.runtime", "SklearnCharTfidfVectorizer"),
    ("sklearn.decomposition._pca", "PCA"),
    ("sklearn.decomposition._truncated_svd", "TruncatedSVD"),
    ("sklearn.feature_extraction.text", "TfidfVectorizer"),
    ("sklearn.feature_extraction.text", "TfidfTransformer"),
    ("sklearn.preprocessing._data", "StandardScaler"),
}
ALLOWED = {
    ("numpy", "ndarray"): np.ndarray,
    ("numpy", "dtype"): np.dtype,
    ("numpy", "float32"): np.float32,
    ("numpy", "float64"): np.float64,
    ("numpy", "int64"): np.int64,
    ("numpy.core.multiarray", "scalar"): np.core.multiarray.scalar,
    ("numpy.core.multiarray", "_reconstruct"): np.core.multiarray._reconstruct,
    ("joblib.numpy_pickle", "NumpyArrayWrapper"): NumpyArrayWrapper,
}


class RestrictedUnpickler(NumpyUnpickler):
    def find_class(self, module, name):
        if (module, name) in ALLOWED:
            return ALLOWED[(module, name)]
        if (module, name) in STUBBED:
            return type(name, (Stub,), {})
        raise RuntimeError(f"refusing pickled global {module}.{name}")


def load(path):
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != EXPECTED[path.name]:
        raise RuntimeError(f"{path.name}: sha256 {digest} is not the pinned upstream file")
    with path.open("rb") as handle:
        return RestrictedUnpickler(str(path), handle).load()


def state(obj):
    value = getattr(obj, "state", None)
    return obj.__dict__ if value is None else value


def write_array(out, name, array):
    array = np.asarray(array)
    dtype = {"float32": "<f4", "float64": "<f8"}[str(array.dtype)]
    array = np.ascontiguousarray(array.astype(dtype))
    data = array.tobytes(order="C")
    (out / name).write_bytes(data)
    return {"file": name, "shape": list(array.shape), "dtype": dtype, "sha256": hashlib.sha256(data).hexdigest()}


def plain(value):
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, (tuple, list)):
        return [plain(v) for v in value]
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, type):
        return value.__name__
    if isinstance(value, np.dtype):
        return str(value)
    return f"<{type(value).__name__}>"


def main():
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    meta = {}

    pca = state(state(load(src / "pca64.joblib"))["estimator"])
    meta["pca64"] = {
        "whiten": bool(pca.get("whiten", False)),
        "source_dtype": str(np.asarray(pca["components_"]).dtype),
        "mean": write_array(out, "pca64.mean.bin", pca["mean_"]),
        "components": write_array(out, "pca64.components.bin", pca["components_"]),
        "explained_variance": write_array(out, "pca64.explained_variance.bin", pca["explained_variance_"]),
    }

    svd = state(state(load(src / "svd100.joblib"))["estimator"])
    svd_dtype = str(np.asarray(svd["components_"]).dtype)
    meta["svd100"] = {
        "source_dtype": svd_dtype,
        "components": write_array(out, "svd100.components.bin", svd["components_"]),
    }

    tfidf = state(state(load(src / "tfidf_char_wb_2_4.joblib"))["estimator"])
    transformer = state(tfidf["_tfidf"])
    idf = transformer.get("idf_")
    if idf is None:
        raise RuntimeError("the TF-IDF transformer has no dense idf_")
    tokens = [None] * len(tfidf["vocabulary_"])
    for token, index in tfidf["vocabulary_"].items():
        tokens[int(index)] = token
    vocab_bytes = json.dumps(tokens, ensure_ascii=False).encode("utf-8")
    (out / "tfidf.vocabulary.json").write_bytes(vocab_bytes)
    options = {k: plain(v) for k, v in tfidf.items() if k not in ("vocabulary_", "_tfidf", "stop_words_")}
    options.update({f"transformer.{k}": plain(v) for k, v in transformer.items() if k != "idf_"})
    meta["tfidf"] = {
        "options": options,
        "source_idf_dtype": str(np.asarray(idf).dtype),
        "vocabulary": {"file": "tfidf.vocabulary.json", "size": len(tokens), "sha256": hashlib.sha256(vocab_bytes).hexdigest()},
        "idf": write_array(out, "tfidf.idf.bin", idf),
    }

    scaler = state(load(src / "standard_scaler88.joblib"))
    meta["scaler88"] = {
        "with_mean": bool(scaler.get("with_mean", True)),
        "with_std": bool(scaler.get("with_std", True)),
        "mean": write_array(out, "scaler88.mean.bin", scaler["mean_"]),
        "scale": write_array(out, "scaler88.scale.bin", scaler["scale_"]),
    }
    (out / "transformers.json").write_text(json.dumps(meta, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(meta, indent=1, sort_keys=True))


if __name__ == "__main__":
    main()
