#!/usr/bin/env bash
# Install language packages into the Piston runtimes so server-side R / Python 3
# trinkets can use common libraries (lubridate, numpy, pandas, ...).
#
# WHY THIS EXISTS:
#   Piston ships only base languages. Installed packages live on the
#   `piston_packages` Docker volume, so they survive container restarts BUT NOT
#   a full `docker volume rm` or a fresh droplet. Re-run this script after any
#   such rebuild. Keeping it in the repo makes the package set reproducible.
#
# USAGE (on the droplet, from /opt/trinket/repo):
#   bash deploy/install-packages.sh
#
# Customize the package lists below for your curriculum.
set -euo pipefail

R_PACKAGES=(
  lubridate
  stringr
  jsonlite
)

# Heavier R packages (tidyverse/ggplot2/dplyr) need dev headers and a long
# compile. Uncomment to include them; the apt-get block below covers their
# system dependencies.
R_PACKAGES_HEAVY=(
  # ggplot2
  # dplyr
  # tidyr
  # readr
)

PY_PACKAGES=(
  numpy
  requests
)

# NOTE: pandas (and anything importing the bz2/lzma/sqlite3 stdlib modules)
# does NOT work on Piston's prebuilt Python 3.9.4 — that interpreter was
# compiled without the _bz2 C extension, so `import pandas` fails with
# "No module named '_bz2'". numpy and requests are fine. Getting pandas to
# work requires a custom Python build with full stdlib (the "custom image"
# path), not just a pip install.
PY_PACKAGES_UNSUPPORTED=(
  # pandas
)

PISTON_CONTAINER="${PISTON_CONTAINER:-piston}"
CRAN="${CRAN:-https://cloud.r-project.org}"

echo "==> Locating Piston runtimes..."
RSCRIPT_DIR="$(docker exec "$PISTON_CONTAINER" sh -c 'ls -d /piston/packages/rscript/*/ 2>/dev/null | head -1' | tr -d '\r')"
PYTHON_DIR="$(docker exec "$PISTON_CONTAINER" sh -c 'ls -d /piston/packages/python/*/ 2>/dev/null | head -1' | tr -d '\r')"
echo "    R:      ${RSCRIPT_DIR:-<none>}"
echo "    Python: ${PYTHON_DIR:-<none>}"

install_r() {
  local pkgs=("$@")
  [ ${#pkgs[@]} -eq 0 ] && return 0
  local list
  list="$(printf '"%s",' "${pkgs[@]}")"; list="${list%,}"
  echo "==> Installing R packages: ${pkgs[*]}"
  docker exec "$PISTON_CONTAINER" sh -c "
    export PATH=${RSCRIPT_DIR}bin:\$PATH
    Rscript -e 'install.packages(c(${list}), repos=\"${CRAN}\", lib=\"${RSCRIPT_DIR}lib/R/library\", dependencies=c(\"Depends\",\"Imports\",\"LinkingTo\"))'
  "
}

if [ ${#R_PACKAGES_HEAVY[@]} -gt 0 ]; then
  echo "==> Installing system dev headers for heavy R packages..."
  docker exec "$PISTON_CONTAINER" sh -c "apt-get update -y && apt-get install -y libcurl4-openssl-dev libxml2-dev libssl-dev libfontconfig1-dev libfreetype6-dev" || \
    echo "    (apt-get step failed or unavailable; heavy packages may not compile)"
fi

if [ -n "$RSCRIPT_DIR" ]; then
  install_r "${R_PACKAGES[@]}"
  install_r "${R_PACKAGES_HEAVY[@]}"
fi

if [ -n "$PYTHON_DIR" ] && [ ${#PY_PACKAGES[@]} -gt 0 ]; then
  echo "==> Installing Python packages: ${PY_PACKAGES[*]}"
  docker exec "$PISTON_CONTAINER" sh -c "${PYTHON_DIR}bin/python3 -m pip install --no-input ${PY_PACKAGES[*]}"
fi

echo "==> Done. Installed packages persist on the piston_packages volume."
