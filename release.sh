#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  npm run release
  npm run release -- -v x.x.x
  ./release.sh
  ./release.sh -v x.x.x

Without -v, this script bumps the patch version by 1. It then builds
dist/extension.js, packages a VSIX, commits the release files, creates tag
release/x.x.x, then pushes the current branch and the tag to origin.
EOF
}

version=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -v|--version)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for $1" >&2
        usage
        exit 1
      fi
      version="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

branch="$(git branch --show-current)"
if [[ -z "$branch" ]]; then
  echo "Release must run on a branch, not a detached HEAD." >&2
  exit 1
fi

current_version="$(node -e "console.log(require('./package.json').version)")"

if [[ -z "$version" ]]; then
  version="$(node -e "const v=require('./package.json').version.split('.').map(Number); if (v.length !== 3 || v.some(n => !Number.isInteger(n) || n < 0)) process.exit(1); v[2] += 1; console.log(v.join('.'))")"
fi

if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid version: $version. Expected x.x.x, for example 1.2.3" >&2
  exit 1
fi

if [[ "$current_version" == "$version" ]]; then
  echo "package.json is already at version $version." >&2
  exit 1
fi

tag="release/$version"
package_name="$(node -e "const p=require('./package.json'); console.log(p.name + '-$version.vsix')")"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean. Commit or stash existing changes before releasing." >&2
  git status --short
  exit 1
fi

if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "Local tag already exists: $tag" >&2
  exit 1
fi

remote_tag_status=0
git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1 || remote_tag_status=$?
if [[ "$remote_tag_status" -eq 0 ]]; then
  echo "Remote tag already exists: $tag" >&2
  exit 1
elif [[ "$remote_tag_status" -ne 2 ]]; then
  echo "Failed to check remote tag: $tag" >&2
  exit 1
fi

echo "Updating version: $current_version -> $version"
npm version "$version" --no-git-tag-version

echo "Building production bundle"
npm run package

echo "Packaging VSIX: $package_name"
npx vsce package --out "$package_name"

git add package.json package-lock.json dist/extension.js

if git diff --cached --quiet; then
  echo "No release file changes were staged." >&2
  exit 1
fi

git commit -m "chore: release $version"
git tag -a "$tag" -m "Release $version"

if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  git push
else
  git push -u origin "$branch"
fi

git push origin "$tag"

echo "Released $version"
echo "VSIX: $package_name"
echo "Tag: $tag"
