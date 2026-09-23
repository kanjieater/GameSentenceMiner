from GameSentenceMiner.util.config import electron_config


def test_basic_default_profile_overrides_recognition_defaults_only(monkeypatch):
    custom = {
        "advancedMode": True,
        "twoPassOCR": False,
        "optimize_second_scan": False,
        "text_appears_instantly": True,
        "ocr1": "oneocr",
        "ocr2": "oneocr",
        "scanRate": 1.25,
        "language": "en",
        "duplicate_similarity_threshold": 55,
        "change_detection_threshold": 44,
        "manualOcrHotkey": "Alt+M",
        "furigana_filter_sensitivity": 7,
    }

    monkeypatch.setattr(
        electron_config.electron_store,
        "get",
        lambda key, default=None: custom if key == "OCR" else default,
    )
    monkeypatch.setenv("GSM_OCR_PROFILE_PRESET", "basic-default")

    effective = electron_config._get_ocr_config()

    assert effective["advancedMode"] is False
    assert effective["twoPassOCR"] is True
    assert effective["optimize_second_scan"] is True
    assert effective["text_appears_instantly"] is False
    assert effective["ocr1"] == electron_config.DEFAULT_STABILITY_OCR
    assert effective["ocr2"] == "glens"
    assert effective["scanRate"] == 0.5
    assert effective["language"] == "ja"
    assert effective["duplicate_similarity_threshold"] == 80
    assert effective["change_detection_threshold"] == 20

    # User utility/per-scene preferences are not reset by the runtime preset.
    assert effective["manualOcrHotkey"] == "Alt+M"
    assert effective["furigana_filter_sensitivity"] == 7

    assert electron_config.get_ocr_two_pass_ocr() is True
    assert electron_config.get_ocr_optimize_second_scan() is True
    assert electron_config.get_ocr_text_appears_instantly() is False
    assert electron_config.get_ocr_ocr1() == electron_config.DEFAULT_STABILITY_OCR
    assert electron_config.get_ocr_ocr2() == "glens"
    assert electron_config.get_ocr_scan_rate() == 0.5
    assert electron_config.get_ocr_language() == "ja"


def test_profile_preset_absent_preserves_existing_advanced_ocr(monkeypatch):
    custom = {
        "advancedMode": True,
        "twoPassOCR": False,
        "optimize_second_scan": False,
        "text_appears_instantly": True,
        "ocr1": "oneocr",
        "ocr2": "oneocr",
        "scanRate": 1.25,
        "language": "en",
    }

    monkeypatch.setattr(
        electron_config.electron_store,
        "get",
        lambda key, default=None: custom if key == "OCR" else default,
    )
    monkeypatch.delenv("GSM_OCR_PROFILE_PRESET", raising=False)

    assert electron_config.get_ocr_two_pass_ocr() is False
    assert electron_config.get_ocr_optimize_second_scan() is False
    assert electron_config.get_ocr_text_appears_instantly() is True
    assert electron_config.get_ocr_ocr1() == "oneocr"
    assert electron_config.get_ocr_ocr2() == "oneocr"
    assert electron_config.get_ocr_scan_rate() == 1.25
    assert electron_config.get_ocr_language() == "en"
