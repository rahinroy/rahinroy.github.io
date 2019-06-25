$(function() {
	$(window).scroll(function () {
	    $('.about').css('visibility', 'visible').hide().fadeIn(1000);
    $(this).off('scroll');
	});
});

