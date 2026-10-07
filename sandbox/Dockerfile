# Shell:B code sandbox — run with --network none; this image is the whole toolbox.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      bc curl file jq less nano unzip xz-utils zip fonts-dejavu-core \
      git build-essential cmake pkg-config nodejs npm ripgrep sqlite3 \
      poppler-utils tesseract-ocr tesseract-ocr-spa tesseract-ocr-jpn \
      ffmpeg sox libsndfile1 fluidsynth fluid-soundfont-gm socat \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir \
      numpy pandas scipy sympy scikit-learn matplotlib seaborn pillow openpyxl xlsxwriter \
      pyarrow tabulate networkx statsmodels python-docx python-pptx pdfplumber pypdf pymupdf pytesseract opencv-python-headless reportlab beautifulsoup4 lxml pyyaml rich \
      pytest pytest-cov hypothesis ruff mypy black requests httpx fastapi pydantic flask
# creative + back-end: audio editing/MIDI, meshes, and a real app server (Studio dev servers run uvicorn or node)
RUN pip install --no-cache-dir \
      soundfile pydub mido pretty_midi midiutil pyloudnorm trimesh pygltflib \
      'uvicorn[standard]' sqlalchemy sqlmodel aiosqlite python-multipart jinja2 pyjwt passlib bcrypt
RUN npm install -g --no-fund --no-audit typescript tsx prettier eslint vitest \
      express sql.js ws zod
# documents: convert, render and typeset (docx/pptx → PDF, Markdown → anything, LaTeX math), plus wide font
# coverage so charts and PDFs survive non-Latin text; more OCR languages; Go, Rust, Java and R toolchains
RUN apt-get update && apt-get install -y --no-install-recommends \
      pandoc imagemagick ghostscript librsvg2-bin \
      libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui \
      texlive-latex-base texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended \
      texlive-xetex texlive-science texlive-lang-cjk texlive-lang-chinese lmodern \
      fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji fonts-liberation2 fonts-dejavu fonts-firacode \
      tesseract-ocr-fra tesseract-ocr-deu tesseract-ocr-ita tesseract-ocr-por tesseract-ocr-rus \
      tesseract-ocr-ara tesseract-ocr-hin tesseract-ocr-kor tesseract-ocr-chi-sim tesseract-ocr-chi-tra \
      golang-go rustc cargo default-jdk-headless r-base-core \
    && fc-cache -f && rm -rf /var/lib/apt/lists/* \
    && for b in soffice libreoffice; do \
         printf '#!/bin/sh\nexec /usr/bin/%s -env:UserInstallation=file:///tmp/lo-profile "$@"\n' "$b" > /usr/local/bin/$b; \
         chmod 755 /usr/local/bin/$b; done
# (the wrappers above: with no passwd entry for the run-as uid, LibreOffice can't create its default profile)
# data, ML, optimization, geo and astronomy
RUN pip install --no-cache-dir \
      polars duckdb xgboost lightgbm cvxpy ortools pulp \
      shapely pyproj geopandas folium astropy skyfield \
      pypandoc markdown weasyprint plotly kaleido
# headless Chromium for screenshots and HTML → PDF (playwright, or `chromium --headless` via the shim below)
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN pip install --no-cache-dir playwright && playwright install --with-deps chromium \
    && chrome="$(find /opt/playwright -path '*/chromium-*' -type f -name chrome | head -1)" && test -x "$chrome" \
    && printf '#!/bin/sh\nexec %s --no-sandbox "$@"\n' "$chrome" > /usr/local/bin/chromium && chmod 755 /usr/local/bin/chromium \
    && chmod -R a+rX /opt/playwright && rm -rf /var/lib/apt/lists/*
# the sandbox is offline, so project code require()s these global packages instead of npm install
ENV NODE_PATH=/usr/local/lib/node_modules
ENV MPLBACKEND=Agg PYTHONUNBUFFERED=1
WORKDIR /work
