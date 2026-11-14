import lockupLight from "@/assets/ph/ph-lockup-light.png";
import lockupDark from "@/assets/ph/ph-lockup-dark.png";
import iconColor from "@/assets/ph/ph-icon-color.png";
import iconWhite from "@/assets/ph/ph-icon-white.png";

// Ported from Phenome-Health/ddharmon-ui (frontend/src/components/ph-logo.tsx) so both products carry the same mark.

/**
 * Official Phenome Health icon (three-blade mark) only. Colour on paper, white on the chrome.
 * The call site declares the surface it sits on.
 */
export function PhMark({ className, tone = "paper" }: { className?: string; tone?: "paper" | "ground" }) {
  return <img src={tone === "ground" ? iconWhite : iconColor} alt="" aria-hidden className={className} />;
}

/**
 * Official Phenome Health horizontal lockup (three-blade icon and wordmark).
 * `tone="dark"` is the white-text version for a permanently dark surface; the default is the paper form.
 */
export function PhLogo({ className, tone = "light" }: { className?: string; tone?: "dark" | "light" }) {
  return <img src={tone === "dark" ? lockupDark : lockupLight} alt="Phenome Health" className={className} />;
}
