$( document ).ready(function() {
  // var settings = {
  //   "url": "https://maps.googleapis.com/maps/api/directions/json?key=AIzaSyCVoTQAvf9FZZOmn02sGe6CnQ5IjxcaoWY&origin=30.29111, -97.743464&destination=2317 Speedway, Austin, TX 78712&mode=walking",
  //   "method": "GET",
  //   "timeout": 0,
  // };
  
  // $.ajax(settings).done(function (response) {
  //   console.log(response);
  // });
});




function initMap() {
  map = new google.maps.Map(document.getElementById("map"), {
    center: { lat: -34.397, lng: 150.644 },
    zoom: 8,
  });
}