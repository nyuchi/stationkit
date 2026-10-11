// Class-based dark mode, applied before first paint. Mirrors src/lib/theme.ts:
// any stored value other than "light" or "dark" means "system", and in system
// mode the page follows the OS setting as it changes.
(function () {
  var media = matchMedia("(prefers-color-scheme: dark)");
  function preference() {
    try {
      var t = localStorage.getItem("mws-theme");
      return t === "light" || t === "dark" ? t : "system";
    } catch (e) {
      return "system";
    }
  }
  function apply() {
    var p = preference();
    document.documentElement.classList.toggle(
      "dark",
      p === "dark" || (p === "system" && media.matches),
    );
  }
  apply();
  media.addEventListener("change", apply);
})();
