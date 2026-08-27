"""Parse + fuzzy-match track titles across platforms."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

# Anonymous mix tags with no credited remixer — strip from display + norm
MIX_RE = re.compile(
    r"[\(\[]\s*(?:"
    r"original\s+mix|radio\s+edit|extended\s+mix|club\s+mix|"
    r"instrumental|acapella|edit|remix|mix|version|vip|bootleg"
    r")\s*[\)\]]",
    re.I,
)
# Credited remix/edit: "(mimikri Remix)", "[DJ Koze Rework]"
CREDITED_MIX_RE = re.compile(
    r"[\(\[]\s*(?P<name>[^\)\]]+?)\s+"
    r"(?:re\-?mix(?:es)?|bootlegs?|reworks?|re\-?edits?|"
    r"edits?|vips?|mix(?:es)?|versions?)\s*[\)\]]",
    re.I,
)
ANON_MIX_NAMES = frozenset(
    {
        "original",
        "radio",
        "extended",
        "club",
        "instrumental",
        "acapella",
        "a cappella",
        "main",
        "official",
        "vocal",
        "dub",
        "vip",
        "edit",
        "remix",
        "mix",
        "version",
        "bootleg",
        "rework",
        "reedit",
        "re edit",
    }
)
BRACKET_RE = re.compile(r"\[.*?\]")
FEAT_RE = re.compile(r"\b(?:feat\.?|ft\.?|featuring)\b.*$", re.I)
ARTIST_SPLIT_RE = re.compile(r"\s*,\s*|\s+&\s+|\s+x\s+|\s+vs\.?\s+", re.I)
SEP_RE = re.compile(r"\s+[-–—]\s+")
PIPE_RE = re.compile(r"\s*[|／/]\s*")
PROMO_RE = re.compile(
    r"\b(?:"
    r"premiere|exclusive|free\s*download|free\s*dl|out\s*now|"
    r"released?|snippet|teaser|visuali[sz]er|official(?:\s+audio)?"
    r")\b",
    re.I,
)
PROMO_LEAD_RE = re.compile(
    r"^(?:premiere|exclusive|free\s*download|free\s*dl|out\s*now|"
    r"released?|snippet|teaser|visuali[sz]er|official(?:\s+audio)?)"
    r"\s*[:|\-–—]?\s*",
    re.I,
)
NON_ALNUM_RE = re.compile(r"[^a-z0-9\s]+")
SPACE_RE = re.compile(r"\s+")
HOLD_MIX_RE = re.compile(r"\0MIX(\d+)\0")

# Common UK/US spelling so Behaviour ~= Behavior
SPELLING_REWRITES = (
    (re.compile(r"\bbehaviour\b"), "behavior"),
    (re.compile(r"\bcolour\b"), "color"),
    (re.compile(r"\bfavourite\b"), "favorite"),
    (re.compile(r"\bcentre\b"), "center"),
    (re.compile(r"\bmetre\b"), "meter"),
    (re.compile(r"\btheatre\b"), "theater"),
    (re.compile(r"\brealise\b"), "realize"),
    (re.compile(r"\borganise\b"), "organize"),
)

MATCH_THRESHOLD = 0.84
UNCERTAIN_LOW = 0.72
TITLE_ONLY_THRESHOLD = 0.92
NESTED_TITLE_ARTIST_MAX_TOKENS = 5
DURATION_CLOSE_SEC = 3
DURATION_NEAR_SEC = 8
DURATION_CONFLICT_SEC = 18
BPM_CLOSE = 1.0
BPM_CONFLICT = 8.0


@dataclass(frozen=True)
class ParsedTrack:
    artist: str
    title: str
    artist_norm: str
    title_norm: str
    raw: str


def _fold_ascii(value: str) -> str:
    text = unicodedata.normalize("NFKD", value)
    return "".join(ch for ch in text if not unicodedata.combining(ch))


def _light_norm(value: str | None) -> str:
    """Lowercase alnum fold without mix/promo stripping (for remixer keys)."""
    text = _fold_ascii(str(value or "")).lower()
    text = NON_ALNUM_RE.sub(" ", text)
    return SPACE_RE.sub(" ", text).strip()


def _is_anon_mix_name(name: str | None) -> bool:
    norm = _light_norm(name)
    if not norm:
        return True
    return all(token in ANON_MIX_NAMES for token in norm.split())


def normalize_text(value: str | None) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    text = _fold_ascii(text)
    # Drop credited + anonymous mix tags so remixer doesn't pollute title_norm
    text = CREDITED_MIX_RE.sub(" ", text)
    text = MIX_RE.sub(" ", text)
    text = BRACKET_RE.sub(" ", text)
    text = PIPE_RE.sub(" ", text)
    text = PROMO_RE.sub(" ", text)
    text = FEAT_RE.sub(" ", text)
    text = text.lower()
    for pattern, repl in SPELLING_REWRITES:
        text = pattern.sub(repl, text)
    text = NON_ALNUM_RE.sub(" ", text)
    text = SPACE_RE.sub(" ", text).strip()
    return text


def _extract_remixers(text: str | None) -> list[str]:
    """Pull remixer names from '(Name Remix)' / '[Name Bootleg]' etc."""
    out: list[str] = []
    seen: set[str] = set()
    for match in CREDITED_MIX_RE.finditer(str(text or "")):
        name = SPACE_RE.sub(" ", match.group("name")).strip(" -–—|/,&+")
        if not name or _is_anon_mix_name(name):
            continue
        norm = _light_norm(name)
        if not norm or norm in seen:
            continue
        seen.add(norm)
        out.append(name)
    return out


def _join_artists(primary: str | None, extras: list[str] | None = None) -> str:
    parts: list[str] = []
    seen: set[str] = set()

    def push(name: str) -> None:
        cleaned = SPACE_RE.sub(" ", str(name or "")).strip(" -–—|/,")
        if not cleaned:
            return
        key = _light_norm(cleaned)
        if not key or key in seen:
            return
        seen.add(key)
        parts.append(cleaned)

    for chunk in ARTIST_SPLIT_RE.split(str(primary or "")):
        push(chunk)
    for extra in extras or []:
        push(extra)
    return ", ".join(parts)


def _clean_display(value: str | None, *, keep_credited_mix: bool = True) -> str:
    text = str(value or "").strip()
    held: list[str] = []
    if keep_credited_mix:

        def _hold(match: re.Match[str]) -> str:
            # Keep "(mimikri Remix)" but drop "(Radio Edit)" / "(VIP Mix)"
            if _is_anon_mix_name(match.group("name")):
                return ""
            held.append(match.group(0))
            return f"\0MIX{len(held) - 1}\0"

        text = CREDITED_MIX_RE.sub(_hold, text)
    else:
        text = CREDITED_MIX_RE.sub("", text)
    text = MIX_RE.sub("", text)
    text = BRACKET_RE.sub("", text)
    text = PIPE_RE.split(text, maxsplit=1)[0]
    text = PROMO_LEAD_RE.sub("", text)
    text = PROMO_RE.sub("", text)
    if held:

        def _restore(match: re.Match[str]) -> str:
            idx = int(match.group(1))
            return held[idx] if 0 <= idx < len(held) else ""

        text = HOLD_MIX_RE.sub(_restore, text)
    text = SPACE_RE.sub(" ", text).strip(" -–—|/:")
    return text


def _looks_like_artist_fragment(text: str) -> bool:
    norm = normalize_text(text)
    if not norm:
        return False
    tokens = norm.split()
    if len(tokens) == 0 or len(tokens) > NESTED_TITLE_ARTIST_MAX_TOKENS:
        return False
    if len(norm) > 48:
        return False
    return True


def _split_artist_title_blob(blob: str) -> tuple[str, str] | None:
    cleaned = _clean_display(blob)
    if not cleaned:
        return None
    parts = SEP_RE.split(cleaned, maxsplit=1)
    if len(parts) != 2:
        return None
    left, right = _clean_display(parts[0]), _clean_display(parts[1])
    if not left or not right:
        return None
    if _looks_like_artist_fragment(left):
        return left, right
    if _looks_like_artist_fragment(right):
        # "Title - Artist"
        return right, left
    return left, right


def parse_artist_title(
    raw_title: str | None = None,
    artist: str | None = None,
    title: str | None = None,
) -> ParsedTrack:
    """Return the best artist/title guess, including nested premiere titles."""
    variants = parse_track_variants(raw_title=raw_title, artist=artist, title=title)
    return variants[0]


def parse_track_variants(
    raw_title: str | None = None,
    artist: str | None = None,
    title: str | None = None,
) -> list[ParsedTrack]:
    raw = SPACE_RE.sub(" ", str(raw_title or "").strip())
    artist_in = _clean_display(artist, keep_credited_mix=False)
    title_in = _clean_display(title)
    remixers_global = _extract_remixers(
        " ".join(x for x in (raw, artist or "", title or "") if x)
    )
    seen: set[tuple[str, str]] = set()
    out: list[ParsedTrack] = []

    def add(artist_val: str, title_val: str) -> None:
        # Remixers live in the title/raw more often than the artist field
        remixers = _extract_remixers(
            " ".join(x for x in (artist_val, title_val, raw) if x)
        )
        if remixers_global:
            # Prefer global order, then any extras from this variant
            merged = list(remixers_global)
            seen_r = {_light_norm(r) for r in merged}
            for r in remixers:
                key_r = _light_norm(r)
                if key_r and key_r not in seen_r:
                    seen_r.add(key_r)
                    merged.append(r)
            remixers = merged
        a = _join_artists(_clean_display(artist_val, keep_credited_mix=False), remixers)
        t = _clean_display(title_val)
        an = normalize_text(a)
        tn = normalize_text(t)
        if not an and not tn:
            return
        key = (an, tn)
        if key in seen:
            return
        seen.add(key)
        out.append(
            ParsedTrack(
                artist=a,
                title=t,
                artist_norm=an,
                title_norm=tn,
                raw=raw or f"{a} - {t}".strip(" -"),
            )
        )

    # 1) Nested parse from title (uploader vs real artist)
    #    e.g. artist=tipping point music, title="NUAH - Natural Behavior | PREMIERE"
    nested_from_title = _split_artist_title_blob(title_in) if title_in else None
    if nested_from_title:
        add(nested_from_title[0], nested_from_title[1])

    # 2) Nested parse from raw
    nested_from_raw = _split_artist_title_blob(raw) if raw else None
    if nested_from_raw:
        add(nested_from_raw[0], nested_from_raw[1])
        # raw like "uploader - NUAH - Natural Behavior"
        raw_parts = SEP_RE.split(_clean_display(raw))
        if len(raw_parts) >= 3:
            add(raw_parts[1], " - ".join(raw_parts[2:]))
            add(raw_parts[0], " - ".join(raw_parts[1:]))

    # 3) Explicit artist + title as given
    if artist_in and title_in:
        # If title still embeds artist - title, keep both interpretations
        add(artist_in, title_in)
        if nested_from_title and normalize_text(nested_from_title[0]) != normalize_text(
            artist_in
        ):
            # Prefer nested already added first; also artist + nested title only
            add(artist_in, nested_from_title[1])

    # 4) Fallback from raw / title alone
    if not out:
        if artist_in and title_in:
            add(artist_in, title_in)
        elif nested_from_raw:
            add(nested_from_raw[0], nested_from_raw[1])
        elif title_in:
            add(artist_in, title_in)
        elif raw:
            add("", _clean_display(raw))

    if not out:
        add(artist_in, title_in or _clean_display(raw))

    if not out:
        # Empty payload (legacy migrate) — still return a stub so resolve never crashes.
        out.append(
            ParsedTrack(
                artist="",
                title="",
                artist_norm="",
                title_norm="",
                raw=raw or "",
            )
        )

    # Prefer variants that have both artist and title, nested first
    out.sort(
        key=lambda p: (
            0 if (p.artist_norm and p.title_norm) else 1,
            len(p.title_norm),
        )
    )
    return out


def _tokens(text: str) -> set[str]:
    out: set[str] = set()
    for t in text.split():
        if not t:
            continue
        out.add(t)
        # light plural stem so horizon ~= horizons
        if len(t) > 4 and t.endswith("s") and not t.endswith("ss"):
            out.add(t[:-1])
        elif len(t) > 3:
            out.add(t + "s")
    return out


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0


def _seq_ratio(a: str, b: str) -> float:
    if a == b:
        return 1.0
    if not a or not b:
        return 0.0

    def bigrams(s: str) -> set[str]:
        if len(s) < 2:
            return {s}
        return {s[i : i + 2] for i in range(len(s) - 1)}

    return _jaccard(bigrams(a), bigrams(b))


def similarity(a: str, b: str) -> float:
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    tok = _jaccard(_tokens(a), _tokens(b))
    seq = _seq_ratio(a.replace(" ", ""), b.replace(" ", ""))
    return 0.65 * tok + 0.35 * seq


def artist_similarity(a: str, b: str) -> float:
    """Artist compare that treats remixer extras as compatible (subset)."""
    base = similarity(a, b)
    ta, tb = _tokens(a), _tokens(b)
    if not ta or not tb:
        return base
    if ta <= tb or tb <= ta:
        return max(base, 0.92)
    inter = ta & tb
    if inter and len(inter) >= min(len(ta), len(tb)):
        return max(base, 0.88)
    # Shared primary token when one side has extra remixer credits
    if inter and (len(ta) <= 3 or len(tb) <= 3):
        return max(base, 0.78 * (len(inter) / min(len(ta), len(tb))))
    return base


def durations_conflict(
    duration_a: float | int | None, duration_b: float | int | None
) -> bool:
    da = float(duration_a or 0)
    db = float(duration_b or 0)
    if da <= 0 or db <= 0:
        return False
    return abs(da - db) >= DURATION_CONFLICT_SEC


def durations_close(
    duration_a: float | int | None, duration_b: float | int | None
) -> bool:
    da = float(duration_a or 0)
    db = float(duration_b or 0)
    if da <= 0 or db <= 0:
        return False
    return abs(da - db) <= DURATION_NEAR_SEC


def pair_score(
    artist_a: str,
    title_a: str,
    artist_b: str,
    title_b: str,
) -> float:
    """Score two tracks; also tries swapped artist/title orientations."""

    def one(aa: str, ta: str, ab: str, tb: str) -> float:
        if not ta or not tb:
            return 0.0
        title_s = similarity(ta, tb)
        if title_s < 0.78:
            return 0.0

        if not aa or not ab:
            return title_s if title_s >= TITLE_ONLY_THRESHOLD else 0.0

        artist_s = artist_similarity(aa, ab)
        # Artist appears inside the other title ("NUAH - Natural Behavior")
        if artist_s < 0.72:
            if aa in tb or ab in ta or aa == tb or ab == ta:
                artist_s = max(artist_s, 0.9)
            else:
                return 0.0
        return 0.42 * artist_s + 0.58 * title_s

    direct = one(artist_a, title_a, artist_b, title_b)
    swapped = one(artist_a, title_a, title_b, artist_b)
    swapped2 = one(title_a, artist_a, artist_b, title_b)
    return max(direct, swapped, swapped2)


def best_pair_score(
    variants: list[ParsedTrack],
    artist_b: str,
    title_b: str,
) -> float:
    best = 0.0
    for parsed in variants:
        score = pair_score(
            parsed.artist_norm, parsed.title_norm, artist_b, title_b
        )
        if score > best:
            best = score
    return best


def is_match(
    artist_a: str,
    title_a: str,
    artist_b: str,
    title_b: str,
    threshold: float = MATCH_THRESHOLD,
) -> bool:
    return pair_score(artist_a, title_a, artist_b, title_b) >= threshold


def normalize_label(value: str | None) -> str:
    return normalize_text(value)


def meta_score_delta(
    *,
    duration_a: float | int | None = None,
    duration_b: float | int | None = None,
    bpm_a: float | int | None = None,
    bpm_b: float | int | None = None,
    label_a: str | None = None,
    label_b: str | None = None,
) -> float:
    """Boost/penalty from shared metadata. Range roughly -0.2 .. +0.17."""
    delta = 0.0
    da = float(duration_a or 0)
    db = float(duration_b or 0)
    if da > 0 and db > 0:
        diff = abs(da - db)
        if diff <= DURATION_CLOSE_SEC:
            delta += 0.08
        elif diff <= DURATION_NEAR_SEC:
            delta += 0.03
        elif diff >= DURATION_CONFLICT_SEC:
            delta -= 0.16

    ba = float(bpm_a or 0)
    bb = float(bpm_b or 0)
    if ba > 0 and bb > 0:
        bpm_diff = abs(ba - bb)
        if bpm_diff <= BPM_CLOSE:
            delta += 0.05
        elif bpm_diff >= BPM_CONFLICT:
            delta -= 0.08

    la = normalize_label(label_a)
    lb = normalize_label(label_b)
    if la and lb and la == lb:
        delta += 0.04
    return delta


def combined_match_score(
    name_score: float,
    *,
    duration_a: float | int | None = None,
    duration_b: float | int | None = None,
    bpm_a: float | int | None = None,
    bpm_b: float | int | None = None,
    label_a: str | None = None,
    label_b: str | None = None,
) -> float:
    if name_score <= 0:
        return 0.0
    total = name_score + meta_score_delta(
        duration_a=duration_a,
        duration_b=duration_b,
        bpm_a=bpm_a,
        bpm_b=bpm_b,
        label_a=label_a,
        label_b=label_b,
    )
    return max(0.0, min(1.0, total))


def classify_match(
    score: float,
    *,
    duration_conflict: bool = False,
) -> str:
    """Return 'auto', 'uncertain', or 'none'."""
    if duration_conflict and score >= UNCERTAIN_LOW:
        return "uncertain"
    if score >= MATCH_THRESHOLD:
        return "auto"
    if score >= UNCERTAIN_LOW:
        return "uncertain"
    return "none"


def near_miss_score(
    title_a: str,
    title_b: str,
    artist_a: str = "",
    artist_b: str = "",
    *,
    duration_a: float | int | None = None,
    duration_b: float | int | None = None,
    bpm_a: float | int | None = None,
    bpm_b: float | int | None = None,
    label_a: str | None = None,
    label_b: str | None = None,
) -> float:
    """Suggest uncertain merge when titles are strong and duration agrees."""
    if not title_a or not title_b:
        return 0.0
    title_s = similarity(title_a, title_b)
    if title_s < 0.88:
        return 0.0
    if not durations_close(duration_a, duration_b) and not (
        float(bpm_a or 0) > 0
        and float(bpm_b or 0) > 0
        and abs(float(bpm_a) - float(bpm_b)) <= BPM_CLOSE
    ):
        # Allow near-miss without duration only when title nearly exact
        if title_s < 0.97:
            return 0.0
    artist_s = similarity(artist_a, artist_b) if artist_a and artist_b else 0.0
    base = 0.70 + 0.12 * title_s + 0.05 * artist_s
    return combined_match_score(
        min(0.83, base),
        duration_a=duration_a,
        duration_b=duration_b,
        bpm_a=bpm_a,
        bpm_b=bpm_b,
        label_a=label_a,
        label_b=label_b,
    )
