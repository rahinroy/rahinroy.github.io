



$.getJSON("https://niharannam.com/recipes.json", function(data) {
  let keys = [];
  var title = ""
  for(var k in data) keys.push(k);
  // console.log(keys)
  reset()

  $("#refreshButton").click(function() {reset()});
  $("#showButton").click(function() {show()});
  $("#guessButton").click(function() {guess()});



  function guess() {
    let guess = $("#guess").val();
    if (guess){
      console.log(guess)
      if (title.toLowerCase().includes(guess.toLowerCase())){
        $("#correct").text("correct (maybe)")
      } else {
        $("#correct").text("wrong (maybe)")
      }
    }
  }

  function show() {
    $("#answer").text(title)
  }

  function reset() {
    $("#ingred").empty()
    $("#answer").empty()
    $("#correct").empty()
    $("#guess").val("")
    let randomInt = Math.floor(Math.random() * (keys.length - 1));
    // console.log(data[keys[randomInt]])
    title = keys[randomInt]
    let recipe = data[title]
    let ingredients = [];

    for(var k in recipe) ingredients.push(k);
    console.log(recipe)
    console.log(recipe[ingredients[0]])

    ingredients.forEach((i) => {
      // console.log(i)
      var li = $('<li/>')
        .text(recipe[i] + " " + i)
        .appendTo($('#ingred'))
    })


  }


});
