let buttons = document.querySelectorAll(".hideable-btn")
for (let i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener("click", function() {
        let id = buttons[i].id;
        let d = document.querySelector("#"+id+"-div");
        if (d.classList.contains("invisable")) {
            d.classList.remove("invisable");
            buttons[i].textContent = "隐藏";
        }
        else {
            buttons[i].textContent = "显示";
            d.classList.add("invisable");
        }
    });
    buttons[i].textContent = "显示";
}
