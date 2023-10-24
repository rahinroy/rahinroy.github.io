function showImage(src,target) {
    var fr=new FileReader();
    // when image is loaded, set the src of the image where you want to display it
    fr.onload = function(e) { target.src = this.result; };
    src.addEventListener("change",function() {
      // fill fr with image data    
      fr.readAsDataURL(src.files[0]);
    }); 
  }

function convertImgToCanvas(){
    var myImgElement = document.getElementById("target");
    img_height = myImgElement.height
    img_width = myImgElement.width
    scale_factor = 1
    if (img_height >= img_width && img_height > 512){
        scale_factor = img_height / 512.0
    } else if (img_width > img_height && img_width > 512){
        scale_factor = img_width / 512.0
    }
    myImgElement.style.visibility = "hidden"
    console.log(scale_factor, myImgElement.width / scale_factor, myImgElement.height / scale_factor)

    var myCanvasElement = document.getElementById("canvas");
    myCanvasElement.width = myImgElement.width / scale_factor;
    myCanvasElement.height = myImgElement.height / scale_factor;

    var context = myCanvasElement.getContext('2d');
    context.drawImage(myImgElement, 0, 0, myImgElement.width / scale_factor, myImgElement.height / scale_factor);   
}


function downloadImg(){
    var canvas = document.getElementById("canvas");
    var dataURL = canvas.toDataURL();
    console.log(dataURL)
    var aDownloadLink = document.createElement('a');
    // Add the name of the file to the link

    var fileInput = document.getElementById("src").files[0].name.split(".")[0]
    aDownloadLink.download = fileInput + '_telegram.png';
    // Attach the data to the link
    aDownloadLink.href = dataURL;
    // Get the code to click the download link
    aDownloadLink.click();
}
  
  
var src = document.getElementById("src");
var target = document.getElementById("target");
showImage(src,target);

document.getElementById("resizebutton").onclick = () => convertImgToCanvas()
document.getElementById("downloadbutton").onclick = () => downloadImg()
