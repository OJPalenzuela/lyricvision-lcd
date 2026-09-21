"""Panel registry for Thermalright USB LCDs.

Locked against real glass (LV-01). Each row describes one panel variant:
the USB handshake identity (PM/SUB), the landscape pixel buffer the
firmware expects, the physical glass geometry, and the software transform
that maps the rendered portrait image onto that buffer.

Second row covers the Vision 360 family (480x480 glass). Known PM values
72 and 129 map to 480x480; anything else falls back to ``unknown``.
Never guess silently: unlisted panels MUST surface as unknown so the
bridge (LV-04) can refuse or warn instead of pushing wrong pixels.
"""

from dataclasses import dataclass
from typing import List, Optional, Tuple

# Transform applied in software (LV-04 render stage): the app composes a
# portrait image at glass resolution (W x H, e.g. 480x854) and rotates it
# 90 degrees clockwise into the landscape USB buffer (H x W, e.g. 854x480).
#
# Pixel mapping for a source image of width W and height H:
#   dst(x', y') = src(W - 1 - y', x')   with dst size H x W
# Equivalent to numpy's ``np.rot90(img, k=-1)`` (k=3).
# Verified against glass: ARRIBA/ABAJO markers rendered upright and placed
# (no mirror); red/blue halves ordered blue-top/red-bottom, which is the
# signature of the correct rotation sense.
ROTATE_90_CW = "rot90cw"


@dataclass(frozen=True)
class PanelProfile:
    """One known panel variant."""

    name: str
    pm: int  # panel model byte from handshake response (offset 24)
    sub: Optional[int]  # panel sub-model byte (offset 36); None = any sub
    buffer_size: Tuple[int, int]  # (w, h) landscape buffer the firmware expects
    glass_size: Tuple[int, int]  # (w, h) physical glass resolution
    orientation: str  # physical glass orientation ("portrait" / "square")
    rotation: str  # software transform from glass space to buffer space
    encoding: str  # frame payload encoding ("jpeg" / "rgb565be")
    known: bool = True  # False for the explicit-unknown fallback sentinel


VISION_MAX = PanelProfile(
    name="Peerless Assassin 120 Vision MAX",
    pm=11,
    sub=5,
    buffer_size=(854, 480),
    glass_size=(480, 854),
    orientation="portrait",
    rotation=ROTATE_90_CW,
    encoding="jpeg",
)

# Vision 360 family: 480x480 square glass. PM 72 and PM 129 observed;
# sub-model byte not characterized, so it is left open (None = any).
VISION_360_PM72 = PanelProfile(
    name="Vision 360 (PM72)",
    pm=72,
    sub=None,
    buffer_size=(480, 480),
    glass_size=(480, 480),
    orientation="square",
    rotation="none",
    encoding="jpeg",
)

VISION_360_PM129 = PanelProfile(
    name="Vision 360 (PM129)",
    pm=129,
    sub=None,
    buffer_size=(480, 480),
    glass_size=(480, 480),
    orientation="square",
    rotation="none",
    encoding="jpeg",
)

# Explicit fallback. `known=False` so callers can distinguish "a real row"
# from "we have no idea what this is" without parsing names.
UNKNOWN = PanelProfile(
    name="unknown",
    pm=-1,
    sub=None,
    buffer_size=(0, 0),
    glass_size=(0, 0),
    orientation="unknown",
    rotation="none",
    encoding="unknown",
    known=False,
)

REGISTRY: List[PanelProfile] = [
    VISION_MAX,
    VISION_360_PM72,
    VISION_360_PM129,
]


def lookup(pm: int, sub: int) -> PanelProfile:
    """Return the panel profile for a (pm, sub) handshake pair.

    Exact (pm, sub) rows win first; rows with ``sub=None`` match any sub
    for their pm. Anything else returns the ``UNKNOWN`` sentinel with
    ``known=False`` — never a silent guess.
    """
    for profile in REGISTRY:
        if profile.pm == pm and profile.sub == sub:
            return profile
    for profile in REGISTRY:
        if profile.pm == pm and profile.sub is None:
            return profile
    return UNKNOWN
