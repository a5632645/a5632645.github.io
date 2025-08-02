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

let flash_links = document.querySelectorAll(".flash-link");
for (let i = 0; i < flash_links.length; i++) {
    flash_links[i].addEventListener("click", function() {
        let target = flash_links[i].getAttribute('href');
        let item = document.querySelector(target)
        item.classList.add('flash-animation');
        setTimeout(function() {
            item.classList.remove('flash-animation');
        }, 2000);
    });
}