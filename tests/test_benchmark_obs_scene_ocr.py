from __future__ import annotations

import importlib.util
from pathlib import Path

from PIL import Image


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "benchmark_obs_scene_ocr.py"
SPEC = importlib.util.spec_from_file_location("benchmark_obs_scene_ocr", SCRIPT_PATH)
benchmark_obs_scene_ocr = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(benchmark_obs_scene_ocr)


def test_summarize_timings_computes_expected_core_metrics():
    summary = benchmark_obs_scene_ocr.summarize_timings([0.1, 0.2, 0.3, 0.4])

    assert summary["count"] == 4.0
    assert summary["total_seconds"] == 1.0
    assert summary["avg_seconds"] == 0.25
    assert summary["median_seconds"] == 0.25
    assert summary["min_seconds"] == 0.1
    assert summary["max_seconds"] == 0.4
    assert summary["throughput_fps"] == 4.0
    assert summary["avg_fps"] == 4.0


def test_summarize_timings_uses_at_least_one_sample_for_one_percent_buckets():
    summary = benchmark_obs_scene_ocr.summarize_timings([0.1, 0.2, 0.5])

    assert round(summary["low_1_percent_fps"], 6) == round(1 / 0.5, 6)
    assert round(summary["high_1_percent_fps"], 6) == round(1 / 0.1, 6)

def test_apply_preprocess_variant_box_1080_downsamples_with_expected_aspect_ratio():
    image = Image.new("RGB", (1920, 1200), "white")

    processed = benchmark_obs_scene_ocr.apply_preprocess_variant(image, "box_1080")

    assert processed.size == (1728, 1080)
    assert processed.mode == "RGB"


def test_apply_preprocess_variant_crt_scanlines_keeps_color_and_matches_candidate_size():
    image = Image.new("RGB", (1920, 1200), (40, 80, 120))
    image.paste((180, 210, 240), (960, 600, 1920, 1200))

    processed = benchmark_obs_scene_ocr.apply_preprocess_variant(image, "crt_scanlines")

    assert processed.size == (1728, 1080)
    assert processed.mode == "RGB"
    assert processed.getextrema() == ((0, 255), (0, 255), (0, 255))


def test_apply_preprocess_variant_none_returns_original_image():
    image = Image.new("RGB", (640, 360), "white")

    assert benchmark_obs_scene_ocr.apply_preprocess_variant(image, "none") is image

