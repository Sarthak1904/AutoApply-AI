"""AutoApply Backend — FastAPI application entry point."""

import logging
import re
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.responses import JSONResponse
from dotenv import load_dotenv

# Load environment variables
load_dotenv(Path(__file__).parent / ".env")

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("autoapply")

DATA_DIR = Path(__file__).parent / "data"

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application startup and shutdown events."""
    # Startup: create the private data directory. SQLite initializes lazily.
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    DATA_DIR.chmod(0o700)

    logger.info("AutoApply backend started")
    logger.info(f"Data directory: {DATA_DIR.resolve()}")

    yield  # App runs here

    logger.info("AutoApply backend shutting down")
    from backend.services.database import close_database
    from backend.services.llm_client import close_llm_client

    close_database()
    close_llm_client()


# Create the app
app = FastAPI(
    title="AutoApply API",
    description="AI-powered job application autofill backend",
    version="1.0.0",
    lifespan=lifespan,
)

_TRUSTED_WEB_ORIGINS = {"http://localhost:8000", "http://127.0.0.1:8000"}
_EXTENSION_ORIGIN = re.compile(r"^(?:chrome|moz)-extension://[A-Za-z0-9_-]+$")


def _is_trusted_origin(origin: str | None) -> bool:
    """Allow CLI/same-origin calls and requests from installed extensions."""
    return (
        origin is None
        or origin in _TRUSTED_WEB_ORIGINS
        or _EXTENSION_ORIGIN.fullmatch(origin) is not None
    )


@app.middleware("http")
async def reject_untrusted_browser_origins(request, call_next):
    """Enforce the origin boundary server-side, including simple form requests."""
    origin = request.headers.get("origin")
    if request.url.path.startswith("/api/") and not _is_trusted_origin(origin):
        return JSONResponse(
            status_code=403,
            content={"detail": "This local API only accepts extension or local requests."},
        )
    return await call_next(request)

# API requests are proxied by the extension background context. Only extension
# origins (plus local dashboard development) need cross-origin access; allowing
# every website here would expose the user's local profile and application data.
app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(_TRUSTED_WEB_ORIGINS),
    allow_origin_regex=r"^(?:chrome|moz)-extension://[A-Za-z0-9_-]+$",
    allow_methods=["*"],
    allow_headers=["*"],
)

# Import and include routers
from backend.routers import profile, autofill, applications, workspace

app.include_router(profile.router)
app.include_router(autofill.router)
app.include_router(applications.router)
app.include_router(workspace.router)

# Mount dashboard static files
dashboard_dir = Path(__file__).parent / "dashboard"
if dashboard_dir.exists():
    app.mount("/dashboard/static", StaticFiles(directory=str(dashboard_dir)), name="dashboard-static")


@app.get("/dashboard")
async def serve_dashboard():
    """Serve the applications history dashboard Web UI."""
    if not dashboard_dir.exists():
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Dashboard UI not found.")
    return FileResponse(str(dashboard_dir / "index.html"))


@app.get("/api/health")
async def health_check():
    """Health check endpoint for the extension to verify backend connectivity."""
    profile_exists = (DATA_DIR / "profile.json").exists()
    resume_exists = (DATA_DIR / "resume.pdf").exists()
    knowledge_exists = (DATA_DIR / "knowledge.md").exists()

    from backend.services.database import get_database
    from backend.services.llm_client import inspect_provider_configuration

    app_count = get_database().count_applications()
    provider_config = inspect_provider_configuration()

    return {
        "status": "healthy",
        "profile_loaded": profile_exists,
        "resume_uploaded": resume_exists,
        "knowledge_loaded": knowledge_exists,
        "total_applications": app_count,
        "ai_provider": provider_config["provider"],
        "ai_model": provider_config["model"],
        "ai_ready": provider_config["configured"],
        "ai_error": provider_config["error"],
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "backend.main:app",
        host="127.0.0.1",
        port=8000,
        reload=False,
        log_level="info",
    )
