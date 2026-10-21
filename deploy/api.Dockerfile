# OmniPitch API (FastAPI) for Azure Container Apps. Build context: repository root.
#   docker build -f deploy/api.Dockerfile -t ghcr.io/<owner>/omnipitch-api:<tag> .
# Runtime identity: a user-assigned managed identity (AZURE_CLIENT_ID); no keys or connection strings in the image.
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    OMNIPITCH_DB_PATH=/tmp/omnipitch.sqlite3
WORKDIR /app

COPY services/api/requirements.txt services/api/requirements-azure.txt services/api/
COPY services/bridge/requirements.txt services/bridge/
RUN pip install -r services/bridge/requirements.txt

# Shared monorepo seams the API imports at runtime (contracts, KQL, simulator, analytics, agents, bridge).
COPY contracts contracts
COPY analytics analytics
COPY services/simulator services/simulator
COPY services/analytics services/analytics
COPY services/agents services/agents
COPY services/bridge services/bridge
COPY services/api/app services/api/app

RUN useradd --create-home --uid 10001 omnipitch && chown -R omnipitch /app
USER omnipitch
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "app.main:app", "--app-dir", "services/api", "--host", "0.0.0.0", "--port", "8000"]
