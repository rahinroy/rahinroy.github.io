var FOCUSED_ID = "0"
const NUM_TILES = 100
const ITEMS_IN_ROW = 10
const NUM_ROWS = NUM_TILES / ITEMS_IN_ROW


const gapped_words = ["c_r", "bo_tle", "_rend", "w_nder", "_ook", "bac_"]
const answer = "attack"

$(document).ready(function(){
    startup()
    handlers()
    construct()
});

const uniqId = (() => {
    let i = 0;
    return () => {
        return i++;
    }
})();


function make_block(){
    jQuery('<div>', {
        class: 'item',
        id: uniqId()
    }).appendTo('.wrapper');    
}

function focus_click(){
    $("#" + FOCUSED_ID).click()
}

function focus_next(){
    FOCUSED_ID = Math.min(parseInt(FOCUSED_ID) + 1, NUM_TILES/2 + answer.length - 1).toString()
    focus_click()
}

function focus_back(){
    FOCUSED_ID = Math.max(parseInt(FOCUSED_ID) - 1, NUM_TILES/2 ).toString()
    focus_click()
}

function alt_color_grid(id){
    $("#" + id).css("background-color", "#1b5e20")
    $("#" + id).css("color", "#eeeeee")

}

function hide_grid(id){
    $("#" + id).css("background-color", "#e0e0e0")
    $("#" + id).addClass("hidden")
}


function set_untouchables(id){
    $("#" + id).addClass("untouchable")
}

function check_answer(){
    word = ""
    for (var x = NUM_TILES/2; x < NUM_TILES/2 + answer.length; x++){
        word += $("#" + x).text()
    }
    if (word.length == answer.length){
        if (word.toUpperCase() == answer.toUpperCase()){
            alert("gg")
        }
    }

}

function startup(){
    $(".item").css("border", "0.1em solid transparent")

    make_block()
    for (var x = 0; x < NUM_TILES - 1; x++){
        make_block()
    }
}


function handlers(){
    // WHAT GRID IS FOCUSED ON
    $(".item").on("click", function(e) {
        e.preventDefault();
        if (!$("#" + this.id).hasClass("hidden") && !$("#" + this.id).hasClass("untouchable")){
            FOCUSED_ID = this.id
            $(".item").css("border", "0.1em solid transparent")
            $("#" + FOCUSED_ID).css("border", "0.1em #212121 solid")
        }
    })

    // SUPPORT FOR TYPING
    $(document).on("keypress", function(e){
        var dInput = String.fromCharCode(e.which).toUpperCase();
        
        $("#" + FOCUSED_ID).text(dInput)
        $("#" + FOCUSED_ID).animate({
            fontSize: "4.5vw",
        }, 100);
        $("#" + FOCUSED_ID).animate({
            fontSize: "4vw",
        }, 100, function(){
            check_answer();
        });
        focus_next();



    })


    // SUPPORT FOR BACKSPACE
    $(document).on("keydown", function(e){
        var key = e.keyCode || e.charCode;
        if( key == 8 || key == 46 ){
            if ($("#" + FOCUSED_ID).text() == ""){
                focus_back()
            } else {
                $("#" + FOCUSED_ID).text("")
            }
        }
    })
}

function construct(){
    for (var x = 0; x < gapped_words.length; x++){
        word = gapped_words[x]
        gap_index = word.indexOf("_")
        gap_id = (NUM_TILES / 2) + x
        for (var y = 0; y < word.length; y++){
            char = word[y]
            id = (gap_id - 10 * (gap_index - y)).toString()
            $("#" + id).text(char)
        }
    }

    // FOR THE GRID WITH NO POSSIBLE LETTERS
    for (var x = 0; x < NUM_TILES; x++){
        if ($("#" + x.toString()).text() == ""){
            hide_grid(x)
        }
    }


    for (var x = 0; x < NUM_TILES; x++){
        if ($("#" + x.toString()).text() != "" && $("#" + x.toString()).text() != "_"){
            set_untouchables(x)
        }
    }
    // FOR THE GRID YOU CAN TYPE IN
    for (var x = NUM_TILES / 2; x < answer.length + (NUM_TILES / 2); x++){
        $("#" + x.toString()).text("")
        alt_color_grid(x)
    }


    FOCUSED_ID = (NUM_TILES / 2).toString()
    // startup game on first tile selected
    focus_click()

}