




/*
     FILE ARCHIVED ON 4:49:12 Nov 30, 2012 AND RETRIEVED FROM THE
     INTERNET ARCHIVE ON 8:41:23 Apr 5, 2015.
     JAVASCRIPT APPENDED BY WAYBACK MACHINE, COPYRIGHT INTERNET ARCHIVE.

     ALL OTHER CONTENT MAY ALSO BE PROTECTED BY COPYRIGHT (17 U.S.C.
     SECTION 108(a)(3)).
*/
/*======================================================================*\
|| #################################################################### ||
|| # vBulletin 4.2.0 Patch Level 2
|| # ---------------------------------------------------------------- # ||
|| # Copyright ©2000-2012 vBulletin Solutions Inc. All Rights Reserved. ||
|| # This file may not be redistributed in whole or significant part. # ||
|| # ---------------- VBULLETIN IS NOT FREE SOFTWARE ---------------- # ||
|| # /web/20121130044912/http://www.vbulletin.com | /web/20121130044912/http://www.vbulletin.com/license.html # ||
|| #################################################################### ||
\*======================================================================*/
function display_post(A){if(AJAX_Compatible){vB_PostLoader[A]=new vB_AJAX_PostLoader(A);vB_PostLoader[A].init()}else{pc_obj=fetch_object("postcount"+this.postid);openWindow("showthread.php?"+(SESSIONURL?"s="+SESSIONURL:"")+(pc_obj!=null?"&postcount="+PHP.urlencode(pc_obj.name):"")+"&p="+A+"#post"+A)}return false}var vB_PostLoader=new Array();function vB_AJAX_PostLoader(A){this.postid=A;this.post=YAHOO.util.Dom.get("post_"+this.postid)}vB_AJAX_PostLoader.prototype.init=function(){if(this.post){postid=this.postid;pc_obj=fetch_object("postcount"+this.postid);YAHOO.util.Connect.asyncRequest("POST",fetch_ajax_url("showpost.php?p="+this.postid),{success:this.display,failure:this.handle_ajax_error,timeout:vB_Default_Timeout,scope:this},SESSIONURL+"securitytoken="+SECURITYTOKEN+"&ajax=1&postid="+this.postid+(pc_obj!=null?"&postcount="+PHP.urlencode(pc_obj.name):""))}};vB_AJAX_PostLoader.prototype.handle_ajax_error=function(A){vBulletin_AJAX_Error_Handler(A)};vB_AJAX_PostLoader.prototype.display=function(B){if(B.responseXML){var C=B.responseXML.getElementsByTagName("postbit");if(C.length){var A=string_to_node(C[0].firstChild.nodeValue);this.post.parentNode.replaceChild(A,this.post);PostBit_Init(A,this.postid)}else{openWindow("showthread.php?"+(SESSIONURL?"s="+SESSIONURL:"")+(pc_obj!=null?"&postcount="+PHP.urlencode(pc_obj.name):"")+"&p="+this.postid+"#post"+this.postid)}}};