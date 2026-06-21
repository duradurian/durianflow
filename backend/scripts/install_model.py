"""Install a release-approved model into the managed model store."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.config import Settings
from app.model_manifest import get_official_model_spec
from app.model_store import (
    ModelUnavailableError,
    _resolve_path,
    is_valid_official_model_dir,
    models_root,
    remove_managed_model_tree,
)


def resolve_models_dir(value: str) -> Path:
    """Development-only override kept separate from the release install path."""
    return _resolve_path(value)


def _download_release_artifact(spec, staging: Path) -> None:
    try:
        from huggingface_hub import snapshot_download
    except ImportError as exc:
        raise SystemExit("huggingface-hub is required to install the release model.") from exc
    try:
        # ``revision`` is immutable release metadata, not the repository's
        # mutable default branch.  Only the declared inference inputs download.
        snapshot_download(
            repo_id=spec.repository_id,
            revision=spec.revision,
            local_dir=str(staging),
            allow_patterns=list(spec.files),
        )
    except Exception as exc:
        raise SystemExit("Official model download failed.") from exc


def main() -> None:
    parser = argparse.ArgumentParser(description="Install the release-approved offline transcription model.")
    parser.add_argument("model", nargs="?", default="large-v3-turbo", help="Approved release model ID.")
    parser.add_argument("--force", action="store_true", help="Replace an invalid managed model directory.")
    parser.add_argument("--development-models-dir", help="Development-only managed-root override.")
    parser.add_argument("--development", action="store_true", help="Allow the development model-root override.")
    args = parser.parse_args()

    try:
        spec = get_official_model_spec(args.model)
    except ValueError as exc:
        raise SystemExit("Model is not approved for this release.") from exc
    if args.development_models_dir and not args.development:
        raise SystemExit("--development-models-dir requires --development.")

    settings = Settings()
    root = resolve_models_dir(args.development_models_dir) if args.development_models_dir else models_root(settings)
    # The IDs come only from the release manifest, so this is not an
    # attacker-controlled path segment.
    target = root / spec.model_id
    staging = root / f".{spec.model_id}.staging-{uuid4().hex}"
    try:
        root.mkdir(parents=True, exist_ok=True)
        # Re-check after creation before any destructive operation.
        root = models_root(Settings(_env_file=None, MODELS_DIR=str(root)))
        target = root / spec.model_id
        staging = root / staging.name
        if is_valid_official_model_dir(target, spec):
            print(f"Release-approved model already installed at {target}")
            return
        if target.exists() or target.is_symlink():
            if not args.force:
                raise SystemExit("Model directory exists but failed integrity verification. Re-run with --force.")
            remove_managed_model_tree(target, root)

        _download_release_artifact(spec, staging)
        if not is_valid_official_model_dir(staging, spec):
            raise SystemExit("Downloaded model failed release integrity verification.")
        staging.replace(target)
    except ModelUnavailableError as exc:
        raise SystemExit("Managed model directory is unsafe.") from exc
    finally:
        # A failed/interrupted install must not leave an eligible model tree.
        if staging.exists() or staging.is_symlink():
            try:
                remove_managed_model_tree(staging, root)
            except ModelUnavailableError:
                # Do not recursively delete a link/reparse point; leave it for
                # a user/admin to inspect rather than crossing a trust boundary.
                pass

    print("Release-approved model installed.")
    print(f"MODEL_NAME={spec.model_id}")
    print("ALLOW_MODEL_DOWNLOAD=false")


if __name__ == "__main__":
    main()
