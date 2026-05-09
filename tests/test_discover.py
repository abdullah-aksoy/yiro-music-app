from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_discover_feed_requires_auth() -> None:
    response = client.get("/api/discover/feed")
    assert response.status_code == 401


def test_discover_by_artist_requires_auth() -> None:
    response = client.get("/api/discover/by-artist", params={"artist": "Test"})
    assert response.status_code == 401


def test_discover_like_requires_auth() -> None:
    response = client.post("/api/discover/samples/1/like")
    assert response.status_code == 401


def test_discover_sample_get_requires_auth() -> None:
    response = client.get("/api/discover/samples/1")
    assert response.status_code == 401
