$(document).ready(function() {
	$(window).scroll(function () {

	    $('.bot').css('visibility', 'visible').hide().fadeIn(1000);

    $(this).off('scroll');

	    
});


/*
const words = ["Application Vulnerability.", "IT Security", "Security Penetration Testing" ,  "Managed Security Services"];
let i = 0;
let timer;

$('.word').css('text-align','center');
function typingEffect() {
	$('.word').css('text-align','center');
	let word = words[i].split("");
	var loopTyping = function() {
		$('.word').css('text-align','center');
		if (word.length > 0) {
			document.getElementById('word').innerHTML += word.shift();
		} else {
			deletingEffect();
			return false;
		};
		timer = setTimeout(loopTyping, 100);
	};
	loopTyping();
};

function deletingEffect() {
		$('.word').css('text-align','center');

	let word = words[i].split("");
	var loopDeleting = function() {
		if (word.length > 0) {
			word.pop();
			document.getElementById('word').innerHTML = word.join("");
		} else {
			if (words.length > (i + 1)) {
				i++;
			} else {
				i = 0;
			};
			typingEffect();
			return false;
		};
		timer = setTimeout(loopDeleting, 200);
	};
	loopDeleting();
};

typingEffect();
*/});