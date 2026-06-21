import { injectable } from '@/fw';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import type { TemplateResult } from 'lit';
import { html } from 'lit';
import feather from 'feather-icons';
import { ALIGNMENT_ICON_SVGS } from '@/features/alignment/alignmentIcons';

// Feather icon typing helper
type FeatherIcon = { toSvg?: (opts?: Record<string, unknown>) => string };
type FeatherIconMap = Record<string, FeatherIcon>;

/**
 * Standard icon sizes used throughout the application
 */
export const IconSize = {
  SMALL: 14,
  MEDIUM: 16,
  LARGE: 18,
  XLARGE: 24,
} as const;

export type IconSizeValue = (typeof IconSize)[keyof typeof IconSize];

/**
 * Centralized icon service for rendering SVG icons throughout the application.
 * Supports Feather Icons library and custom SVG registrations with caching for performance.
 */
@injectable()
export class IconService {
  private readonly customIcons = new Map<string, string>();
  private readonly iconCache = new Map<string, string>();

  constructor() {
    this.registerCustomIcons();
  }

  /**
   * Register all custom SVG icons not available in Feather Icons
   */
  private registerCustomIcons(): void {
    // Custom grid icon (viewport)
    this.customIcons.set(
      'grid',
      `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M6 3V21M12 3V21M18 3V21M3 6H21M3 12H21M3 18H21" 
        stroke="currentColor" 
        stroke-width="2" 
        stroke-linecap="round" 
        stroke-linejoin="round"/>
</svg>`
    );

    // Snap-to-grid icon (viewport toolbar)
    this.customIcons.set(
      'snap',
      `<svg viewBox="0 0 2000 2000" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><g><path d="M9315 19985 c-83 -18 -138 -39 -215 -81 -56 -32 -273 -244 -1623 -1593 -3936 -3932 -5449 -5451 -5583 -5606 -1218 -1400 -1884 -3179 -1884 -5030 0 -1214 274 -2365 825 -3465 491 -981 1219 -1865 2120 -2577 1167 -922 2652 -1495 4155 -1605 227 -16 894 -16 1120 0 1009 74 1977 344 2910 812 544 272 1037 604 1555 1045 147 126 1656 1628 5621 5597 1679 1681 1589 1585 1650 1763 24 70 28 96 28 205 1 142 -18 222 -81 342 -49 94 -121 174 -429 478 -148 145 -854 848 -1569 1561 -878 875 -1321 1310 -1365 1339 -220 148 -473 169 -708 60 -46 -22 -102 -54 -125 -71 -23 -18 -1430 -1419 -3127 -3114 -1697 -1695 -3103 -3095 -3125 -3112 -151 -112 -379 -221 -584 -277 -175 -48 -264 -60 -476 -60 -213 0 -325 15 -510 69 -467 135 -888 482 -1101 907 -88 175 -135 315 -176 518 -32 164 -32 471 1 640 51 263 176 553 318 740 43 57 561 578 3123 3145 1125 1128 2286 2293 2581 2590 529 533 536 541 577 625 60 122 76 194 76 325 0 133 -13 192 -69 310 -30 65 -63 114 -117 175 -130 146 -3190 3196 -3241 3230 -165 110 -376 154 -552 115z m1205 -2770 l1055 -1055 -300 -302 c-165 -167 -619 -622 -1008 -1013 l-707 -710 -1060 1060 -1060 1060 1007 1007 c555 555 1010 1008 1013 1008 3 0 480 -475 1060 -1055z m-3028 -3032 l1057 -1058 -1320 -1325 c-899 -903 -1343 -1356 -1394 -1421 -420 -546 -654 -1211 -669 -1898 -20 -898 319 -1740 950 -2367 213 -212 417 -371 644 -501 546 -314 1109 -460 1720 -447 677 14 1331 242 1885 657 51 38 566 546 1418 1396 l1337 1336 1063 -1063 1062 -1062 -1700 -1698 c-1771 -1770 -1800 -1797 -2144 -2056 -813 -612 -1830 -1033 -2841 -1176 -587 -83 -1218 -82 -1805 4 -1249 183 -2433 759 -3358 1631 -778 734 -1333 1616 -1667 2650 -285 883 -364 1859 -226 2800 150 1021 562 2006 1186 2835 241 320 314 396 2049 2133 927 928 1688 1687 1691 1687 3 0 481 -476 1062 -1057z m9562 -3511 c495 -494 973 -969 1061 -1055 l160 -156 -1010 -1011 -1010 -1010 -1062 1062 -1063 1063 1002 1002 c552 552 1007 1003 1012 1003 4 0 414 -404 910 -898z" transform="matrix(.1 0 0 -.1 0 2000)" stroke="none"></path></g></svg>`
    );

    // Close/cross icon (welcome screen)
    this.customIcons.set(
      'x-close',
      `<svg viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M11 1L1 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M1 1L11 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`
    );

    // Plus circle outline (welcome screen)
    this.customIcons.set(
      'plus-circle-outline',
      `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.5" />
  <path d="M10 6V14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
  <path d="M6 10H14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
</svg>`
    );

    // Folder icon (welcome screen, asset browser)
    this.customIcons.set(
      'folder-outline',
      `<svg viewBox="0 0 18 14" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M1 3.5C1 2.67157 1.67157 2 2.5 2H6.5L8 4H15.5C16.3284 4 17 4.67157 17 5.5V11.5C17 12.3284 16.3284 13 15.5 13H2.5C1.67157 13 1 12.3284 1 11.5V3.5Z"
      stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </svg>`
    );

    // Folder icon with fill for asset tree
    this.customIcons.set(
      'folder-solid',
      `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 7C3 5.89543 3.89543 5 5 5H9L11 8H19C20.1046 8 21 8.89543 21 10V17C21 18.1046 20.1046 19 19 19H5C3.89543 19 3 18.1046 3 17V7Z" 
      stroke="currentColor" 
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      fill="none"/>
  </svg>`
    );

    // File icon for asset tree
    this.customIcons.set(
      'file-solid',
      `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M14 2H6C4.89543 2 4 2.89543 4 4V20C4 21.1046 4.89543 22 6 22H18C19.1046 22 20 21.1046 20 20V8L14 2Z" 
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        fill="none"/>
      <path d="M14 2V8H20" 
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        fill="none"/>
    </svg>`
    );

    // Chevron right (caret for asset tree)
    this.customIcons.set(
      'chevron-right-caret',
      `<svg viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg">
  <path d="M4 2L8 6L4 10" 
        stroke="currentColor" 
        stroke-width="1.6" 
        stroke-linecap="round" 
        stroke-linejoin="round" 
        fill="none" 
        style="opacity:0.5"/>
</svg>`
    );

    // Chevron down (caret for dropdown)
    this.customIcons.set(
      'chevron-down-caret',
      `<svg viewBox="0 0 12 12">
  <path d="M3 4L6 7L9 4" 
        stroke="currentColor" 
        stroke-width="1.2" 
        stroke-linecap="round" 
        stroke-linejoin="round" 
        fill="none"/>
</svg>`
    );

    // Zoom to default icon (reset zoom to 100%)
    this.customIcons.set(
      'zoom-default',
      `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="11" cy="11" r="8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M21 21L16.65 16.65" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M8 11H14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M11 8V14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`
    );

    // Zoom all icon (fit all content in view)
    this.customIcons.set(
      'zoom-all',
      `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="3" y="3" width="7" height="7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="14" y="3" width="7" height="7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="3" y="14" width="7" height="7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="14" y="14" width="7" height="7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M10 12H14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M12 10V14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`
    );

    // Zoom in (magnifier with plus) — viewport zoom overlay
    this.customIcons.set(
      'zoom-in',
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2000 2000" preserveAspectRatio="xMidYMid meet"><g class="nc-icon-wrapper" fill="currentColor"><g transform="matrix(.1 0 0 -.1 0 2000)" fill="currentColor" stroke="none"><path d="M8985 19994 c-455 -19 -798 -51 -1135 -105 -1762 -281 -3376 -1038 -4690 -2198 -1015 -897 -1796 -1953 -2341 -3162 -457 -1017 -732 -2122 -800 -3224 -17 -258 -17 -923 0 -1180 69 -1113 339 -2197 801 -3225 467 -1037 1092 -1942 1906 -2754 718 -718 1505 -1286 2402 -1735 1112 -557 2270 -871 3547 -963 237 -17 983 -17 1220 0 1288 93 2432 404 3562 971 611 306 1156 659 1704 1104 l166 135 1704 -1705 c937 -938 1738 -1734 1779 -1770 310 -268 770 -234 1026 75 223 270 215 662 -19 932 -36 41 -832 842 -1770 1779 l-1705 1704 135 166 c441 542 799 1095 1099 1694 572 1141 882 2276 976 3572 17 236 17 983 0 1220 -120 1672 -638 3193 -1555 4565 -573 857 -1351 1670 -2202 2300 -1398 1035 -3125 1672 -4845 1785 -210 14 -806 26 -965 19z m930 -1448 c2081 -176 3941 -1119 5310 -2691 1023 -1176 1667 -2629 1859 -4190 40 -329 51 -523 51 -950 0 -234 -6 -473 -13 -575 -39 -515 -144 -1109 -277 -1568 -335 -1155 -867 -2135 -1646 -3027 -183 -210 -554 -581 -754 -755 -1190 -1036 -2639 -1680 -4210 -1874 -110 -13 -279 -30 -375 -38 -229 -17 -920 -17 -1150 0 -1563 117 -3065 699 -4280 1661 -1314 1040 -2254 2443 -2705 4036 -139 492 -224 969 -272 1520 -21 253 -24 940 -5 1180 58 712 183 1332 396 1960 282 837 736 1673 1270 2340 467 583 1048 1138 1616 1541 1073 762 2336 1250 3620 1398 185 21 298 31 600 50 130 9 798 -4 965 -18z"></path><path d="M9135 14984 c-88 -19 -234 -89 -304 -147 -105 -88 -184 -206 -233 -352 l-23 -70 -3 -1492 -2 -1493 -1493 -2 -1492 -3 -70 -23 c-209 -71 -349 -191 -440 -377 -97 -200 -98 -425 -3 -621 88 -180 254 -320 454 -380 56 -17 147 -19 1551 -21 l1493 -3 2 -1493 3 -1492 24 -70 c82 -242 235 -401 466 -482 73 -25 93 -27 220 -27 127 0 147 2 220 27 206 72 369 224 445 417 51 129 50 97 50 1661 l0 1459 1459 0 c1564 0 1532 -1 1661 50 193 76 345 239 417 445 25 73 27 93 27 220 0 127 -2 147 -27 220 -81 231 -240 384 -482 466 l-70 24 -1492 3 -1493 2 0 1461 c0 1642 4 1543 -75 1704 -79 161 -178 259 -340 336 -138 66 -298 85 -450 53z"></path></g></g></svg>`
    );

    // Zoom out (magnifier with minus) — viewport zoom overlay
    this.customIcons.set(
      'zoom-out',
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2000 2000" preserveAspectRatio="xMidYMid meet"><g class="nc-icon-wrapper" fill="currentColor"><g transform="matrix(.1 0 0 -.1 0 2000)" fill="currentColor" stroke="none"><path d="M8985 19994 c-455 -19 -798 -51 -1135 -105 -1762 -281 -3376 -1038 -4690 -2198 -1225 -1083 -2112 -2401 -2646 -3931 -273 -781 -444 -1629 -495 -2455 -17 -258 -17 -923 0 -1180 94 -1502 556 -2965 1349 -4265 673 -1104 1663 -2135 2742 -2857 1257 -840 2666 -1354 4155 -1517 385 -42 565 -51 1020 -51 455 0 634 9 1020 51 1789 195 3469 901 4876 2052 l146 120 1704 -1705 c937 -938 1738 -1734 1779 -1770 310 -268 770 -234 1026 75 223 270 215 662 -19 932 -36 41 -832 842 -1770 1779 l-1705 1704 135 166 c442 544 799 1094 1099 1694 572 1141 882 2276 976 3572 17 236 17 983 0 1220 -120 1672 -638 3193 -1555 4565 -573 857 -1351 1670 -2202 2300 -1398 1035 -3125 1672 -4845 1785 -210 14 -806 26 -965 19z m930 -1448 c2081 -176 3941 -1119 5310 -2691 1023 -1176 1667 -2629 1859 -4190 40 -329 51 -523 51 -950 0 -234 -6 -473 -13 -575 -39 -515 -144 -1109 -277 -1568 -388 -1340 -1053 -2463 -2031 -3434 -253 -250 -430 -408 -664 -592 -822 -646 -1687 -1089 -2710 -1387 -474 -138 -1056 -241 -1580 -281 -229 -17 -920 -17 -1150 0 -1563 117 -3065 699 -4280 1661 -1418 1122 -2395 2661 -2800 4406 -84 363 -141 734 -177 1150 -21 253 -24 940 -5 1180 58 712 183 1332 396 1960 282 837 736 1673 1270 2340 467 583 1048 1138 1616 1541 1073 762 2336 1250 3620 1398 185 21 298 31 600 50 130 9 798 -4 965 -18z"></path><path d="M5598 11420 c-164 -28 -328 -122 -435 -251 -63 -76 -128 -217 -149 -319 -19 -97 -15 -228 11 -324 64 -235 256 -428 501 -503 56 -17 217 -18 3714 -21 2737 -2 3674 0 3730 9 263 40 476 222 567 484 25 73 27 93 27 220 0 127 -2 147 -27 220 -81 231 -240 384 -482 466 l-70 24 -3670 1 c-2018 1 -3691 -2 -3717 -6z"></path></g></g></svg>`
    );

    // Magnifying glass (zoom to fit / show all) — viewport zoom overlay
    this.customIcons.set(
      'zoom-fit',
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2000 2000" preserveAspectRatio="xMidYMid meet"><g class="nc-icon-wrapper" fill="currentColor"><path d="M8270 19994 c-922 -42 -1700 -186 -2495 -463 -1223 -425 -2301 -1095 -3219 -2001 -763 -752 -1377 -1635 -1802 -2588 -427 -958 -660 -1893 -735 -2947 -17 -231 -17 -895 0 -1135 69 -1020 311 -1993 725 -2922 546 -1225 1373 -2304 2421 -3158 1279 -1043 2830 -1692 4465 -1870 318 -34 444 -41 830 -47 405 -6 711 8 1065 48 1620 182 3146 817 4410 1834 83 67 156 125 164 129 10 6 671 -649 2390 -2367 2600 -2599 2408 -2415 2589 -2475 65 -22 96 -26 202 -26 142 -1 220 17 345 82 96 50 237 191 287 287 65 125 83 203 82 345 0 106 -4 137 -26 202 -60 181 124 -11 -2475 2589 -1707 1708 -2373 2381 -2368 2390 5 8 54 70 110 139 1111 1368 1772 3059 1889 4830 30 453 16 1040 -34 1500 -214 1943 -1076 3735 -2466 5124 -742 741 -1608 1337 -2562 1762 -911 406 -1866 647 -2852 719 -189 14 -787 26 -940 19z m910 -1448 c1395 -123 2704 -637 3793 -1492 698 -548 1356 -1300 1770 -2024 649 -1135 968 -2321 968 -3600 -1 -694 -88 -1330 -270 -1960 -343 -1190 -948 -2217 -1821 -3090 -870 -871 -1900 -1478 -3090 -1821 -1006 -291 -2112 -349 -3185 -168 -1008 170 -2070 611 -2895 1202 -1144 820 -2014 1926 -2517 3197 -265 670 -426 1365 -485 2095 -17 209 -17 880 0 1090 152 1895 1022 3618 2452 4855 628 544 1269 931 2065 1250 624 249 1404 427 2060 469 94 7 190 13 215 15 109 9 778 -4 940 -18z" transform="matrix(.1 0 0 -.1 0 2000)" fill="currentColor" stroke="none"></path></g></svg>`
    );

    // Viewport icon for 2D root containers and camera-space UI
    this.customIcons.set(
      'viewport',
      `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="3" y="4" width="18" height="12" rx="2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M8 20H16" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M12 16V20" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`
    );

    this.customIcons.set(
      'camera-projection-perspective',
      `<svg viewBox="0 0 24 18" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 2L20 6.5V14L12 17L4 14V6.5L12 2Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
  <path d="M4 6.5L12 10.5L20 6.5" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
  <path d="M12 10.5V17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
  <path d="M4 14L1.5 15.5M20 14L22.5 15.5M4 6.5L1.5 5M20 6.5L22.5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
</svg>`
    );

    this.customIcons.set(
      'camera-projection-orthographic',
      `<svg viewBox="0 0 24 18" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 2.25L20.5 6.5V13.5L12 15.75L3.5 13.5V6.5L12 2.25Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
  <path d="M12 2.25V15.75" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
  <path d="M3.5 6.5L12 10.25L20.5 6.5" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
  <path d="M7.25 8.15V14.45M16.75 8.15V14.45" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
</svg>`
    );

    // Gamepad icon for Joystick2D nodes
    this.customIcons.set(
      'gamepad',
      `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M6 7H18C20.2091 7 22 8.79086 22 11V15C22 17.2091 20.2091 19 18 19H6C3.79086 19 2 17.2091 2 15V11C2 8.79086 3.79086 7 6 7Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M6 13H10M8 11V15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="15" cy="12" r="1" fill="currentColor"/>
  <circle cx="18" cy="14" r="1" fill="currentColor"/>
</svg>`
    );

    // UI button icon
    this.customIcons.set(
      'ui-button',
      `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="3" y="7" width="18" height="10" rx="2" stroke="currentColor" stroke-width="2"/>
  <path d="M8 12H16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
</svg>`
    );

    // UI slider icon
    this.customIcons.set(
      'ui-slider',
      `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M4 8H20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <path d="M4 16H20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <circle cx="9" cy="8" r="2" fill="currentColor"/>
  <circle cx="15" cy="16" r="2" fill="currentColor"/>
</svg>`
    );

    // UI bar/progress icon
    this.customIcons.set(
      'ui-bar',
      `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="3" y="8" width="18" height="8" rx="2" stroke="currentColor" stroke-width="2"/>
  <rect x="5" y="10" width="10" height="4" rx="1" fill="currentColor"/>
</svg>`
    );

    // UI checkbox icon
    this.customIcons.set(
      'ui-checkbox',
      `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" stroke-width="2"/>
  <path d="M8 12L11 15L16 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`
    );

    // UI inventory slot icon
    this.customIcons.set(
      'ui-inventory-slot',
      `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" stroke-width="2"/>
  <path d="M12 4V20" stroke="currentColor" stroke-width="1.5"/>
  <path d="M4 12H20" stroke="currentColor" stroke-width="1.5"/>
</svg>`
    );

    this.customIcons.set(
      'sparkles',
      `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 3L13.8 8.2L19 10L13.8 11.8L12 17L10.2 11.8L5 10L10.2 8.2L12 3Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
  <path d="M18.5 15L19.4 17.1L21.5 18L19.4 18.9L18.5 21L17.6 18.9L15.5 18L17.6 17.1L18.5 15Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
  <path d="M5.5 14L6.2 15.5L7.7 16.2L6.2 16.9L5.5 18.4L4.8 16.9L3.3 16.2L4.8 15.5L5.5 14Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
</svg>`
    );

    for (const [name, svg] of Object.entries(ALIGNMENT_ICON_SVGS)) {
      this.customIcons.set(name, svg);
    }
  }

  /**
   * Get an icon as a Lit TemplateResult ready for rendering
   * @param name - Icon name (Feather icon name or custom icon key)
   * @param size - Icon size in pixels (default: MEDIUM/16px)
   * @returns TemplateResult with SVG content
   */
  getIcon(name: string, size: number = IconSize.MEDIUM): TemplateResult {
    return html`${unsafeHTML(this.resolveIconSvg(name, size))}`;
  }

  /**
   * Get icon as raw SVG markup string (useful for HTML-string renderers).
   */
  getIconSvg(name: string, size: number = IconSize.MEDIUM): string {
    return this.resolveIconSvg(name, size);
  }

  /**
   * Get an icon that accepts raw SVG strings or icon names
   * (Used by components like pix3-dropdown-button that support both)
   * @param iconName - Icon name or raw SVG string
   * @param size - Icon size in pixels
   * @returns TemplateResult with SVG content
   */
  getIconOrRawSvg(iconName: string, size: number = IconSize.MEDIUM): TemplateResult {
    // If it's already an SVG string, return it wrapped
    if (iconName.includes('<svg') || iconName.includes('<?xml')) {
      return html`${unsafeHTML(iconName)}`;
    }
    // Otherwise, resolve as icon name
    return this.getIcon(iconName, size);
  }

  /**
   * Register a custom icon at runtime
   * @param name - Unique icon name
   * @param svgContent - SVG content string
   */
  registerIcon(name: string, svgContent: string): void {
    this.customIcons.set(name, svgContent);
    // Clear cached entries for this icon
    Array.from(this.iconCache.keys())
      .filter(key => key.startsWith(`${name}-`))
      .forEach(key => this.iconCache.delete(key));
  }

  /**
   * Apply width and height attributes to an SVG string
   */
  private applySizeToSvg(svg: string, size: number): string {
    // Only modify the opening <svg ...> tag to add/replace width/height
    const updated = svg.replace(/<svg([^>]*)>/, (_match, attrs) => {
      // Remove any existing width/height attributes inside the opening tag (avoid touching stroke-width)
      let newAttrs = attrs.replace(/\s(?:width|height)="[^"]*"/g, '');

      // Ensure there's a display style on the svg tag (but don't clobber existing style)
      if (!/\bstyle\s*=/.test(newAttrs)) {
        newAttrs = `${newAttrs} style="display:block"`;
      }

      // Append explicit width and height
      newAttrs = `${newAttrs} width="${size}" height="${size}"`;

      return `<svg${newAttrs}>`;
    });

    return updated;
  }

  private resolveIconSvg(name: string, size: number): string {
    const cacheKey = `${name}-${size}`;
    const cached = this.iconCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    let svg = '';

    if (this.customIcons.has(name)) {
      svg = this.applySizeToSvg(this.customIcons.get(name)!, size);
    } else {
      try {
        const featherIcons = feather.icons as FeatherIconMap;
        const icon = featherIcons[name];
        if (icon && typeof icon.toSvg === 'function') {
          svg = icon.toSvg({
            width: size,
            height: size,
            stroke: 'currentColor',
            fill: 'none',
            'stroke-width': 2,
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round',
          } as Record<string, unknown>);
        } else {
          console.warn(`[IconService] Icon not found: ${name}`);
          const fallbackIcon = featherIcons['box'];
          if (fallbackIcon && typeof fallbackIcon.toSvg === 'function') {
            svg = fallbackIcon.toSvg({
              width: size,
              height: size,
              stroke: 'currentColor',
              fill: 'none',
              'stroke-width': 2,
              'stroke-linecap': 'round',
              'stroke-linejoin': 'round',
            } as Record<string, unknown>);
          }
        }
      } catch (error) {
        console.warn(`[IconService] Failed to load icon: ${name}`, error);
      }
    }

    if (svg) {
      this.iconCache.set(cacheKey, svg);
    }

    return svg;
  }

  /**
   * Clear the icon cache (useful for testing or memory management)
   */
  clearCache(): void {
    this.iconCache.clear();
  }

  dispose(): void {
    this.iconCache.clear();
    this.customIcons.clear();
  }
}
