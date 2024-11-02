#define STANDARD
attribute vec4 reference;
attribute vec4 seeds;
uniform sampler2D texturePosition;
uniform sampler2D textureVelocity;
uniform sampler2D textureAnimation;
uniform float size;
uniform float time;

varying vec3 vViewPosition;

#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>

    vec4 tmpPos = texture2D(texturePosition, reference.xy);

    vec3 pos = tmpPos.xyz;
    vec3 velocity = normalize(texture2D(textureVelocity, reference.xy).xyz);
    vec3 aniPos = texture2D(textureAnimation, vec2(reference.z, mod(time + (seeds.x) * ((0.0004 + seeds.y / 10000.0) + normalize(velocity) / 20000.0), reference.w))).xyz;
    vec3 newPosition = position;

    newPosition = mat3(modelMatrix) * (newPosition + aniPos);
    newPosition *= size + seeds.y * size * 0.2;

    velocity.z *= -1.;
    float xz = length(velocity.xz);
    float xyz = 1.;
    float x = sqrt(1. - velocity.y * velocity.y);

    float cosry = velocity.x / xz;
    float sinry = velocity.z / xz;

    float cosrz = x / xyz;
    float sinrz = velocity.y / xyz;

    mat3 maty = mat3(cosry, 0, -sinry, 0, 1, 0, sinry, 0, cosry);
    mat3 matz = mat3(cosrz, sinrz, 0, -sinrz, cosrz, 0, 0, 0, 1);

    newPosition = maty * matz * newPosition;
    newPosition += pos;

    vec3 transformed = vec3(newPosition);

	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
    vViewPosition = -mvPosition.xyz;
	#include <worldpos_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
}