FROM nginx:1.27-alpine

RUN rm /etc/nginx/conf.d/default.conf

COPY nginx.conf /etc/nginx/conf.d/app.conf

COPY index.html /usr/share/nginx/html/index.html
COPY login.html /usr/share/nginx/html/login.html
COPY counter-offer.html /usr/share/nginx/html/counter-offer.html
COPY info-request.html /usr/share/nginx/html/info-request.html
COPY Gemini_Generated_Image_jcqzs8jcqzs8jcqz.png /usr/share/nginx/html/

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost/login || exit 1

CMD ["nginx", "-g", "daemon off;"]
