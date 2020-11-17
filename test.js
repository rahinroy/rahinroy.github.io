$(function(){
    var about = false;
    var proj = false;
    var awar = false;

    $("#bio").click(function(){
        if (proj || awar){
            if (proj){
                $("#projects").click();
            }
            if (awar){
                $("#awards").click();
            }
        }
        if (!about){
            $("#bio").css('color', '#7bc74d');
            $(".bioInfo").show("medium");
            about = true;
        } else {
            $("#bio").css('color', '#eeeeee');
            $(".bioInfo").hide("medium");
            about = false;
        }
    })
    $("#projects").click(function(){
        if (about || awar){
            if (about){
                $("#bio").click();
            }
            if (awar){
                $("#awards").click();
            }
        }
        if (!proj){
            $("#projects").css('color', '#bc6ff1');
            $(".projInfo").show("medium");
            $('html, body').animate({
                scrollTop: $("#projects").offset().top
            }, 500);          
            console.log("ahhh")
            proj = true;
        } else {
            $("#projects").css('color', '#eeeeee');
            $(".projInfo").hide("medium");
            proj = false;
        }
    })
    $("#awards").click(function(){
        if (about || proj){
            if (about){
                $("#bio").click();
            }
            if (proj){
                $("#projects").click();
            }
        }
        if (!awar){
            $("#awards").css('color', '#ffa45b');
            $(".awarInfo").show("medium");    
            awar = true;
        } else {
            $("#awards").css('color', '#eeeeee');
            $(".awarInfo").hide("medium");
            awar = false;
        }
    })
});